package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

var errNetUnavailable = errors.New("[balrun]: raw network sockets are not supported in browser environments")

type palNet struct{ proxy js.Value }

func newPalNet(proxy js.Value) pal.Net {
	n := &palNet{proxy: proxy}
	return pal.Net{
		Dial:              n.dial,
		Listen:            n.listen,
		DialPacket:        n.dialPacket,
		ListenPacket:      n.listenPacket,
		ResolvePacketAddr: n.resolvePacketAddr,
	}
}

func (n *palNet) call(method string, args ...any) (js.Value, error) {
	if n.proxy.Type() != js.TypeObject || n.proxy.IsNull() {
		return js.Undefined(), errNetUnavailable
	}
	if n.proxy.Get(method).Type() != js.TypeFunction {
		return js.Undefined(), fmt.Errorf("network platform does not implement %q", method)
	}
	return awaitPromise(n.proxy.Call(method, args...))
}

func (n *palNet) dial(ctx context.Context, network, address, localAddr string, tlsCfg *pal.TLSConfig) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result, err := n.call("dial", network, address, localAddr, tlsOptions(tlsCfg))
	if err != nil {
		return nil, netHostError(err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &wasmConn{proxy: result}, nil
}

func (n *palNet) listen(network, address string, tlsCfg *pal.ServerTLSConfig) (net.Listener, error) {
	result, err := n.call("listen", network, address, serverTLSOptions(tlsCfg))
	if err != nil {
		return nil, netHostError(err)
	}
	return &wasmListener{proxy: result}, nil
}

func (n *palNet) dialPacket(ctx context.Context, network, address, localAddr string) (net.Conn, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result, err := n.call("dialPacket", network, address, localAddr)
	if err != nil {
		return nil, netHostError(err)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &wasmPacket{proxy: result, connected: true}, nil
}

func (n *palNet) listenPacket(network, address string) (net.PacketConn, error) {
	result, err := n.call("listenPacket", network, address)
	if err != nil {
		return nil, netHostError(err)
	}
	return &wasmPacket{proxy: result}, nil
}

func (n *palNet) resolvePacketAddr(network, address string) (net.Addr, error) {
	result, err := n.call("resolvePacketAddr", network, address)
	if err != nil {
		return nil, netHostError(err)
	}
	return addressFromJS(result), nil
}

type wasmConn struct {
	proxy         js.Value
	mu            sync.RWMutex
	readDeadline  time.Time
	writeDeadline time.Time
}

func (c *wasmConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	result, err := callProxy(c.proxy, "read", len(p), deadlineMillis(c.readDeadlineValue()))
	if err != nil {
		return 0, netHostError(err)
	}
	if result.IsNull() || result.IsUndefined() {
		return 0, io.EOF
	}
	if result.Get("byteLength").Type() != js.TypeNumber {
		return 0, errors.New("network read result is not a byte array")
	}
	return js.CopyBytesToGo(p, result), nil
}

func (c *wasmConn) Write(p []byte) (int, error) {
	result, err := callProxy(c.proxy, "write", bytesToJS(p))
	if err != nil {
		return 0, netHostError(err)
	}
	return result.Int(), nil
}

func (c *wasmConn) Close() error         { _, err := callProxy(c.proxy, "close"); return netHostError(err) }
func (c *wasmConn) LocalAddr() net.Addr  { return proxyAddress(c.proxy, "localAddress") }
func (c *wasmConn) RemoteAddr() net.Addr { return proxyAddress(c.proxy, "remoteAddress") }
func (c *wasmConn) SetDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline, c.writeDeadline = t, t
	c.mu.Unlock()
	return nil
}

func (c *wasmConn) SetReadDeadline(t time.Time) error {
	c.mu.Lock()
	c.readDeadline = t
	c.mu.Unlock()
	return nil
}

func (c *wasmConn) SetWriteDeadline(t time.Time) error {
	c.mu.Lock()
	c.writeDeadline = t
	c.mu.Unlock()
	return nil
}

func (c *wasmConn) readDeadlineValue() time.Time {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.readDeadline
}

type wasmListener struct{ proxy js.Value }

func (l *wasmListener) Accept() (net.Conn, error) {
	result, err := callProxy(l.proxy, "accept")
	if err != nil {
		return nil, netHostError(err)
	}
	return &wasmConn{proxy: result}, nil
}

func (l *wasmListener) Close() error   { _, err := callProxy(l.proxy, "close"); return netHostError(err) }
func (l *wasmListener) Addr() net.Addr { return proxyAddress(l.proxy, "address") }

type wasmPacket struct {
	proxy         js.Value
	connected     bool
	mu            sync.RWMutex
	readDeadline  time.Time
	writeDeadline time.Time
}

func (p *wasmPacket) Read(b []byte) (int, error) { n, _, err := p.ReadFrom(b); return n, err }
func (p *wasmPacket) Write(b []byte) (int, error) {
	if !p.connected {
		return 0, errors.New("write requires a connected packet socket")
	}
	return p.write(b, js.Undefined())
}

func (p *wasmPacket) Close() error         { _, err := callProxy(p.proxy, "close"); return netHostError(err) }
func (p *wasmPacket) LocalAddr() net.Addr  { return proxyAddress(p.proxy, "localAddress") }
func (p *wasmPacket) RemoteAddr() net.Addr { return nil }
func (p *wasmPacket) SetDeadline(t time.Time) error {
	p.mu.Lock()
	p.readDeadline, p.writeDeadline = t, t
	p.mu.Unlock()
	return nil
}

func (p *wasmPacket) SetReadDeadline(t time.Time) error {
	p.mu.Lock()
	p.readDeadline = t
	p.mu.Unlock()
	return nil
}

func (p *wasmPacket) SetWriteDeadline(t time.Time) error {
	p.mu.Lock()
	p.writeDeadline = t
	p.mu.Unlock()
	return nil
}

func (p *wasmPacket) readDeadlineValue() time.Time {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.readDeadline
}

func (p *wasmPacket) ReadFrom(b []byte) (int, net.Addr, error) {
	result, err := callProxy(p.proxy, "readFrom", len(b), deadlineMillis(p.readDeadlineValue()))
	if err != nil {
		return 0, nil, netHostError(err)
	}
	if result.IsNull() || result.IsUndefined() {
		return 0, nil, io.EOF
	}
	data := result.Get("data")
	if data.Get("byteLength").Type() != js.TypeNumber {
		return 0, nil, errors.New("packet read result is not a byte array")
	}
	return js.CopyBytesToGo(b, data), addressFromJS(result.Get("address")), nil
}

func (p *wasmPacket) WriteTo(b []byte, addr net.Addr) (int, error) {
	return p.write(b, addressToJS(addr))
}

func (p *wasmPacket) write(b []byte, address js.Value) (int, error) {
	result, err := callProxy(p.proxy, "writeTo", bytesToJS(b), address)
	if err != nil {
		return 0, netHostError(err)
	}
	return result.Int(), nil
}

func callProxy(proxy js.Value, method string, args ...any) (js.Value, error) {
	if proxy.Type() != js.TypeObject || proxy.IsNull() {
		return js.Undefined(), errors.New("network handle is unavailable")
	}
	if proxy.Get(method).Type() != js.TypeFunction {
		return js.Undefined(), fmt.Errorf("network handle does not implement %q", method)
	}
	return awaitPromise(proxy.Call(method, args...))
}

type wasmAddr struct{ network, address string }

func (a wasmAddr) Network() string { return a.network }
func (a wasmAddr) String() string  { return a.address }
func proxyAddress(proxy js.Value, method string) net.Addr {
	result, err := callProxy(proxy, method)
	if err != nil {
		return wasmAddr{network: "unknown"}
	}
	return addressFromJS(result)
}

func addressFromJS(value js.Value) net.Addr {
	address, port := value.Get("address"), value.Get("port")
	if address.Type() != js.TypeString || port.Type() != js.TypeNumber {
		return wasmAddr{network: "unknown"}
	}
	return wasmAddr{network: "udp", address: net.JoinHostPort(address.String(), fmt.Sprint(port.Int()))}
}

func addressToJS(addr net.Addr) js.Value {
	host, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return js.Undefined()
	}
	var number int
	if _, err := fmt.Sscan(port, &number); err != nil {
		return js.Undefined()
	}
	return js.ValueOf(map[string]any{"address": host, "port": number})
}

type timeoutError struct{ error }

func (timeoutError) Timeout() bool   { return true }
func (timeoutError) Temporary() bool { return true }
func netHostError(err error) error {
	if err == nil {
		return nil
	}
	result := hostError(err)
	if strings.Contains(result.Error(), "network operation timed out") {
		return timeoutError{result}
	}
	return result
}

func deadlineMillis(deadline time.Time) any {
	if deadline.IsZero() {
		return js.Undefined()
	}
	return deadline.UnixMilli()
}

func bytesToJS(data []byte) js.Value {
	value := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(value, data)
	return value
}

func tlsOptions(cfg *pal.TLSConfig) any {
	if cfg == nil {
		return js.Undefined()
	}
	return map[string]any{"ca": bytesToJS(cfg.CACertPEM), "cert": bytesToJS(cfg.ClientCertPEM), "key": bytesToJS(cfg.ClientKeyPEM), "serverName": cfg.ServerName, "minVersion": cfg.MinVersion, "maxVersion": cfg.MaxVersion, "cipherSuites": cfg.CipherSuiteNames, "disableSessionTickets": cfg.DisableSessionTickets, "insecureSkipVerify": cfg.InsecureSkipVerify, "skipHostnameVerification": cfg.SkipHostnameVerification}
}

func serverTLSOptions(cfg *pal.ServerTLSConfig) any {
	if cfg == nil {
		return js.Undefined()
	}
	return map[string]any{"ca": bytesToJS(cfg.ClientCACertPEM), "cert": bytesToJS(cfg.CertPEM), "key": bytesToJS(cfg.KeyPEM), "minVersion": cfg.MinVersion, "maxVersion": cfg.MaxVersion, "cipherSuites": cfg.CipherSuiteNames, "disableSessionTickets": cfg.DisableSessionTickets}
}
