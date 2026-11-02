package main

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strconv"
	"syscall/js"
	"time"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

// net.ts sets these codes; netHostError maps them to the errors callers check for.
const (
	netTimeoutCode = "BALRUN_NET_TIMEOUT"
	netClosedCode  = "BALRUN_NET_CLOSED"
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
	return callProxy(n.proxy, method, args...)
}

func (n *palNet) dial(ctx context.Context, network, address, localAddr string, tlsCfg *pal.TLSConfig) (net.Conn, error) {
	result, err := dialWithContext(ctx, func(signal any) (js.Value, error) {
		return n.call("dial", network, address, localAddr, tlsOptions(tlsCfg), signal)
	})
	if err != nil {
		return nil, err
	}
	return &wasmConn{netHandle{result, "tcp"}}, nil
}

func (n *palNet) listen(network, address string, tlsCfg *pal.ServerTLSConfig) (net.Listener, error) {
	result, err := n.call("listen", network, address, serverTLSOptions(tlsCfg))
	if err != nil {
		return nil, netHostError(err)
	}
	return &wasmListener{netHandle{result, "tcp"}}, nil
}

func (n *palNet) dialPacket(ctx context.Context, network, address, localAddr string) (net.Conn, error) {
	result, err := dialWithContext(ctx, func(signal any) (js.Value, error) {
		return n.call("dialPacket", network, address, localAddr, signal)
	})
	if err != nil {
		return nil, err
	}
	return &wasmPacket{netHandle{result, "udp"}, true}, nil
}

func (n *palNet) listenPacket(network, address string) (net.PacketConn, error) {
	result, err := n.call("listenPacket", network, address)
	if err != nil {
		return nil, netHostError(err)
	}
	return &wasmPacket{netHandle{result, "udp"}, false}, nil
}

func (n *palNet) resolvePacketAddr(network, address string) (net.Addr, error) {
	result, err := n.call("resolvePacketAddr", network, address)
	if err != nil {
		return nil, netHostError(err)
	}
	return addressFromJS(result, "udp"), nil
}

// dialWithContext aborts the host dial when ctx ends, and closes a handle that
// was established too late for the caller to receive it.
func dialWithContext(ctx context.Context, dial func(signal any) (js.Value, error)) (js.Value, error) {
	if err := ctx.Err(); err != nil {
		return js.Undefined(), err
	}
	var signal any = js.Undefined()
	if ctx.Done() != nil {
		controller := js.Global().Get("AbortController").New()
		signal = controller.Get("signal")
		stop := context.AfterFunc(ctx, func() { controller.Call("abort") })
		defer stop()
	}
	result, err := dial(signal)
	if ctxErr := ctx.Err(); ctxErr != nil {
		if err == nil {
			_, _ = callProxy(result, "close")
		}
		return js.Undefined(), ctxErr
	}
	if err != nil {
		return js.Undefined(), netHostError(err)
	}
	return result, nil
}

// netHandle holds what stream, listener and packet handles have in common.
type netHandle struct {
	proxy   js.Value
	network string
}

func (h netHandle) Close() error { _, err := callProxy(h.proxy, "close"); return netHostError(err) }
func (h netHandle) address(method string) net.Addr {
	return addressFromJS(h.proxy.Call(method), h.network)
}
func (h netHandle) LocalAddr() net.Addr  { return h.address("localAddress") }
func (h netHandle) RemoteAddr() net.Addr { return h.address("remoteAddress") }
func (h netHandle) SetDeadline(t time.Time) error {
	return errors.Join(h.SetReadDeadline(t), h.SetWriteDeadline(t))
}
func (h netHandle) SetReadDeadline(t time.Time) error {
	return h.setDeadline("setReadDeadline", t)
}
func (h netHandle) SetWriteDeadline(t time.Time) error {
	return h.setDeadline("setWriteDeadline", t)
}

// setDeadline is synchronous because the host applies a new deadline to operations
// already in flight, as net.Conn requires.
func (h netHandle) setDeadline(method string, t time.Time) error {
	if !h.proxy.Call(method, deadlineMillis(t)).Bool() {
		return net.ErrClosed
	}
	return nil
}

type wasmConn struct{ netHandle }

func (c *wasmConn) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	result, err := callProxy(c.proxy, "read", len(p))
	if err != nil {
		return 0, netHostError(err)
	}
	if result.IsNull() {
		return 0, io.EOF
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

type wasmListener struct{ netHandle }

func (l *wasmListener) Accept() (net.Conn, error) {
	result, err := callProxy(l.proxy, "accept")
	if err != nil {
		return nil, netHostError(err)
	}
	return &wasmConn{netHandle{result, "tcp"}}, nil
}

func (l *wasmListener) Addr() net.Addr { return l.address("address") }

type wasmPacket struct {
	netHandle
	connected bool
}

func (p *wasmPacket) Read(b []byte) (int, error) { n, _, err := p.ReadFrom(b); return n, err }
func (p *wasmPacket) Write(b []byte) (int, error) {
	if !p.connected {
		return 0, errors.New("write requires a connected packet socket")
	}
	return p.write(b, js.Undefined())
}

func (p *wasmPacket) RemoteAddr() net.Addr {
	if !p.connected {
		return nil
	}
	return p.address("remoteAddress")
}

func (p *wasmPacket) ReadFrom(b []byte) (int, net.Addr, error) {
	result, err := callProxy(p.proxy, "readFrom", len(b))
	if err != nil {
		return 0, nil, netHostError(err)
	}
	return js.CopyBytesToGo(b, result.Get("data")), addressFromJS(result.Get("address"), p.network), nil
}

func (p *wasmPacket) WriteTo(b []byte, addr net.Addr) (int, error) {
	if p.connected {
		return 0, net.ErrWriteToConnected
	}
	address, err := addressToJS(addr)
	if err != nil {
		return 0, err
	}
	return p.write(b, address)
}

func (p *wasmPacket) write(b []byte, address js.Value) (int, error) {
	result, err := callProxy(p.proxy, "writeTo", bytesToJS(b), address)
	if err != nil {
		return 0, netHostError(err)
	}
	return result.Int(), nil
}

func callProxy(proxy js.Value, method string, args ...any) (js.Value, error) {
	return awaitPromise(proxy.Call(method, args...))
}

type wasmAddr struct{ network, address string }

func (a wasmAddr) Network() string { return a.network }
func (a wasmAddr) String() string  { return a.address }

func addressFromJS(value js.Value, network string) net.Addr {
	return wasmAddr{network: network, address: net.JoinHostPort(value.Get("address").String(), strconv.Itoa(value.Get("port").Int()))}
}

func addressToJS(addr net.Addr) (js.Value, error) {
	if addr == nil {
		return js.Undefined(), errors.New("missing address")
	}
	host, port, err := net.SplitHostPort(addr.String())
	if err != nil {
		return js.Undefined(), err
	}
	number, err := strconv.Atoi(port)
	if err != nil {
		return js.Undefined(), err
	}
	return js.ValueOf(map[string]any{"address": host, "port": number}), nil
}

type timeoutError struct{ error }

func (timeoutError) Timeout() bool        { return true }
func (timeoutError) Temporary() bool      { return true }
func (timeoutError) Is(target error) bool { return target == os.ErrDeadlineExceeded }

func netHostError(err error) error {
	if err == nil {
		return nil
	}
	result := hostError(err)
	jsError, ok := errors.AsType[js.Error](err)
	if !ok || jsError.Value.Type() != js.TypeObject {
		return result
	}
	code := jsError.Value.Get("code")
	if code.Type() != js.TypeString {
		return result
	}
	switch code.String() {
	case netTimeoutCode, "ETIMEDOUT":
		return timeoutError{result}
	case netClosedCode:
		return net.ErrClosed
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
	return map[string]any{
		"ca":                       bytesToJS(cfg.CACertPEM),
		"cert":                     bytesToJS(cfg.ClientCertPEM),
		"key":                      bytesToJS(cfg.ClientKeyPEM),
		"serverName":               cfg.ServerName,
		"minVersion":               cfg.MinVersion,
		"maxVersion":               cfg.MaxVersion,
		"cipherSuites":             stringsToJS(cfg.CipherSuiteNames),
		"handshakeTimeoutMillis":   cfg.HandshakeTimeout.Milliseconds(),
		"disableSessionTickets":    cfg.DisableSessionTickets,
		"insecureSkipVerify":       cfg.InsecureSkipVerify,
		"skipHostnameVerification": cfg.SkipHostnameVerification,
	}
}

func serverTLSOptions(cfg *pal.ServerTLSConfig) any {
	if cfg == nil {
		return js.Undefined()
	}
	return map[string]any{
		"ca":                    bytesToJS(cfg.ClientCACertPEM),
		"cert":                  bytesToJS(cfg.CertPEM),
		"key":                   bytesToJS(cfg.KeyPEM),
		"minVersion":            cfg.MinVersion,
		"maxVersion":            cfg.MaxVersion,
		"cipherSuites":          stringsToJS(cfg.CipherSuiteNames),
		"disableSessionTickets": cfg.DisableSessionTickets,
	}
}

// stringsToJS exists because js.ValueOf panics on []string but accepts []any.
func stringsToJS(values []string) []any {
	result := make([]any, len(values))
	for i, value := range values {
		result[i] = value
	}
	return result
}
