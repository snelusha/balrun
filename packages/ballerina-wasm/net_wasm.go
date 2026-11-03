package main

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

type netDriver interface {
	dial(ctx context.Context, network, address, localAddr string) (net.Conn, error)
	listen(network, address string) (net.Listener, error)
	dialPacket(ctx context.Context, network, address, localAddr string) (net.Conn, error)
	listenPacket(network, address string) (net.PacketConn, error)
	resolvePacketAddr(network, address string) (net.Addr, error)
}

func newPalNet(proxy js.Value, sockets *socketRegistry) pal.Net {
	var driver netDriver = loopbackDriver{}
	loadRoots := func() error { return nil }
	if proxy.Type() == js.TypeObject && !proxy.IsNull() {
		host := hostDriver{proxy: proxy}
		driver = host
		loadRoots = host.loadFallbackRoots
	}

	return pal.Net{
		Dial: func(ctx context.Context, network, address, localAddr string, tlsCfg *pal.TLSConfig) (net.Conn, error) {
			conn, err := driver.dial(ctx, network, address, localAddr)
			if err != nil {
				return nil, err
			}
			registered, err := sockets.registerConn(conn)
			if err != nil {
				return nil, err
			}
			if tlsCfg == nil {
				return registered, nil
			}
			if len(tlsCfg.CACertPEM) == 0 && !tlsCfg.InsecureSkipVerify {
				if err := loadRoots(); err != nil {
					_ = registered.Close()
					return nil, err
				}
			}
			return upgradeClientTLS(ctx, registered, address, *tlsCfg)
		},
		Listen: func(network, address string, tlsCfg *pal.ServerTLSConfig) (net.Listener, error) {
			var serverTLS *tls.Config
			if tlsCfg != nil {
				var err error
				if serverTLS, err = buildServerTLSConfig(tlsCfg); err != nil {
					return nil, err
				}
			}
			listener, err := driver.listen(network, address)
			if err != nil {
				return nil, err
			}
			registered, err := sockets.registerListener(listener)
			if err != nil {
				return nil, err
			}
			if serverTLS != nil {
				return tls.NewListener(registered, serverTLS), nil
			}
			return registered, nil
		},
		DialPacket: func(ctx context.Context, network, address, localAddr string) (net.Conn, error) {
			conn, err := driver.dialPacket(ctx, network, address, localAddr)
			if err != nil {
				return nil, err
			}
			return sockets.registerConn(conn)
		},
		ListenPacket: func(network, address string) (net.PacketConn, error) {
			conn, err := driver.listenPacket(network, address)
			if err != nil {
				return nil, err
			}
			return sockets.registerPacketConn(conn)
		},
		ResolvePacketAddr: driver.resolvePacketAddr,
	}
}

var socketCloseTimeout = 5 * time.Second

// socketRegistry closes whatever a run leaves open. Native programs rely on
// process exit for this, but a WASM run shares its process with the host: an
// open socket would hold its port and keep Node.js from exiting.
type socketRegistry struct {
	mu     sync.Mutex
	open   map[io.Closer]struct{}
	closed bool
}

func newSocketRegistry() *socketRegistry {
	return &socketRegistry{open: make(map[io.Closer]struct{})}
}

func (r *socketRegistry) register(socket, wrapper io.Closer) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		_ = socket.Close()
		return net.ErrClosed
	}
	r.open[wrapper] = struct{}{}
	return nil
}

func (r *socketRegistry) unregister(wrapper io.Closer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.open, wrapper)
}

func (r *socketRegistry) closeAll() {
	r.mu.Lock()
	r.closed = true
	open := make([]io.Closer, 0, len(r.open))
	for socket := range r.open {
		open = append(open, socket)
	}
	r.mu.Unlock()

	// A close that panics or never settles must not stop the run from finishing.
	var closing sync.WaitGroup
	for _, socket := range open {
		closing.Go(func() {
			defer func() { _ = recover() }()
			_ = socket.Close()
		})
	}
	closed := make(chan struct{})
	go func() {
		closing.Wait()
		close(closed)
	}()
	timeout := time.NewTimer(socketCloseTimeout)
	defer timeout.Stop()
	select {
	case <-closed:
	case <-timeout.C:
	}
}

func (r *socketRegistry) registerConn(conn net.Conn) (net.Conn, error) {
	registered := &registeredConn{Conn: conn, sockets: r}
	if err := r.register(conn, registered); err != nil {
		return nil, err
	}
	return registered, nil
}

func (r *socketRegistry) registerPacketConn(conn net.PacketConn) (net.PacketConn, error) {
	registered := &registeredPacketConn{PacketConn: conn, sockets: r}
	if err := r.register(conn, registered); err != nil {
		return nil, err
	}
	return registered, nil
}

func (r *socketRegistry) registerListener(listener net.Listener) (net.Listener, error) {
	registered := &registeredListener{Listener: listener, sockets: r}
	if err := r.register(listener, registered); err != nil {
		return nil, err
	}
	return registered, nil
}

type registeredConn struct {
	net.Conn
	sockets *socketRegistry
}

func (c *registeredConn) Close() error {
	c.sockets.unregister(c)
	return c.Conn.Close()
}

type registeredPacketConn struct {
	net.PacketConn
	sockets *socketRegistry
}

func (c *registeredPacketConn) Close() error {
	c.sockets.unregister(c)
	return c.PacketConn.Close()
}

type registeredListener struct {
	net.Listener
	sockets *socketRegistry
}

func (l *registeredListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	return l.sockets.registerConn(conn)
}

func (l *registeredListener) Close() error {
	l.sockets.unregister(l)
	return l.Listener.Close()
}

// loopbackDriver is backed by Go's js/wasm net package, an in-process fake that
// never reaches the real network. Non-loopback hosts are rejected up front
// because the fake would otherwise report them as a refused connection or a
// failed DNS lookup.
type loopbackDriver struct{}

func (loopbackDriver) dial(ctx context.Context, network, address, localAddr string) (net.Conn, error) {
	return dialLoopback(ctx, network, address, localAddr, func(network, address string) (net.Addr, error) {
		return net.ResolveTCPAddr(network, address)
	})
}

func (loopbackDriver) listen(network, address string) (net.Listener, error) {
	address, err := loopbackAddress(address)
	if err != nil {
		return nil, err
	}
	return net.Listen(network, address)
}

func (loopbackDriver) dialPacket(ctx context.Context, network, address, localAddr string) (net.Conn, error) {
	return dialLoopback(ctx, network, address, localAddr, func(network, address string) (net.Addr, error) {
		return net.ResolveUDPAddr(network, address)
	})
}

func dialLoopback(ctx context.Context, network, address, localAddr string, resolve func(network, address string) (net.Addr, error)) (net.Conn, error) {
	address, err := loopbackAddress(address)
	if err != nil {
		return nil, err
	}
	dialer := net.Dialer{}
	if localAddr != "" {
		localAddr, err := loopbackAddress(localAddr)
		if err != nil {
			return nil, err
		}
		if dialer.LocalAddr, err = resolve(network, localAddr); err != nil {
			return nil, err
		}
	}
	return dialer.DialContext(ctx, network, address)
}

func (loopbackDriver) listenPacket(network, address string) (net.PacketConn, error) {
	address, err := loopbackAddress(address)
	if err != nil {
		return nil, err
	}
	return net.ListenPacket(network, address)
}

func (loopbackDriver) resolvePacketAddr(network, address string) (net.Addr, error) {
	address, err := loopbackAddress(address)
	if err != nil {
		return nil, err
	}
	return net.ResolveUDPAddr(network, address)
}

// loopbackAddress rejects other hosts and spells localhost as an IP, since a
// browser has no hosts file and the fake's resolver would try DNS for it.
func loopbackAddress(address string) (string, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", err
	}
	if !isLoopbackHost(host) {
		return "", fmt.Errorf("sockets are unavailable in this environment: only loopback addresses can be reached, not %q", host)
	}
	if strings.EqualFold(host, "localhost") {
		return net.JoinHostPort("127.0.0.1", port), nil
	}
	return address, nil
}

func isLoopbackHost(host string) bool {
	if host == "" || strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsUnspecified())
}
