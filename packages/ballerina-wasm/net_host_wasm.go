package main

import (
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall/js"
	"time"
)

const closedSocketCode = "ECLOSED"

var errWriteAbandoned = errors.New("stream is unusable for writing after a write timed out")

var hostErrorText = map[string]string{
	"EACCES":        "permission denied",
	"EADDRINUSE":    "address already in use",
	"EADDRNOTAVAIL": "cannot assign requested address",
	"EAFNOSUPPORT":  "address family not supported by protocol",
	"ECONNREFUSED":  "connection refused",
	"ECONNRESET":    "connection reset by peer",
	"EHOSTUNREACH":  "no route to host",
	"EMSGSIZE":      "message too long",
	"ENETUNREACH":   "network is unreachable",
	"ENOTFOUND":     "no such host",
	"EPIPE":         "broken pipe",
	"ETIMEDOUT":     "connection timed out",
}

func hostErrorCode(err error) string {
	if jsError, ok := errors.AsType[js.Error](err); ok && jsError.Value.Type() == js.TypeObject {
		if code := jsError.Value.Get("code"); code.Type() == js.TypeString {
			return code.String()
		}
	}
	return ""
}

func hostNetError(err error) error {
	if text, ok := hostErrorText[hostErrorCode(err)]; ok {
		return errors.New(text)
	}
	return hostError(err)
}

type hostDriver struct {
	proxy js.Value
}

var (
	fallbackRootsMu     sync.Mutex
	fallbackRootsLoaded bool
)

// loadFallbackRoots supplies the host's CA bundle, because crypto/x509 has no
// system roots on js/wasm and would otherwise reject every public certificate.
// A failure is retried on the next connection, since SetFallbackRoots can only
// be called once but only a success calls it.
func (d hostDriver) loadFallbackRoots() error {
	fallbackRootsMu.Lock()
	defer fallbackRootsMu.Unlock()
	if fallbackRootsLoaded {
		return nil
	}
	certificates, err := awaitPromise(d.proxy.Call("rootCertificates"))
	if err != nil {
		return fmt.Errorf("loading the host's CA certificates: %w", hostError(err))
	}
	pool := x509.NewCertPool()
	loaded := false
	for i := 0; i < certificates.Length(); i++ {
		loaded = pool.AppendCertsFromPEM([]byte(certificates.Index(i).String())) || loaded
	}
	if !loaded {
		return errors.New("loading the host's CA certificates: no valid certificates found")
	}
	x509.SetFallbackRoots(pool)
	fallbackRootsLoaded = true
	return nil
}

func (d hostDriver) dial(ctx context.Context, network, address, localAddr string) (net.Conn, error) {
	family, err := networkFamily(network, "tcp")
	if err != nil {
		return nil, err
	}
	host, port, err := splitAddress(address)
	if err != nil {
		return nil, err
	}
	options := map[string]any{"host": dialHost(host), "port": port}
	setFamily(options, family)
	if localAddr != "" {
		localHost, localPort, err := splitAddress(localAddr)
		if err != nil {
			return nil, err
		}
		if localHost != "" {
			if localHost, err = d.resolveIP(ctx, localHost, family); err != nil {
				return nil, dialError(network, address, err)
			}
		}
		options["localHost"] = localHost
		options["localPort"] = localPort
	}
	signal, stop := abortSignal(ctx)
	defer stop()
	if signal.Truthy() {
		options["signal"] = signal
	}
	if err := ctx.Err(); err != nil {
		return nil, dialError(network, address, err)
	}
	socket, err := awaitPromise(d.proxy.Call("connect", js.ValueOf(options)))
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, dialError(network, address, ctxErr)
		}
		return nil, dialError(network, address, hostNetError(err))
	}
	return newStreamConn(network, socket), nil
}

func (d hostDriver) listen(network, address string) (net.Listener, error) {
	family, err := networkFamily(network, "tcp")
	if err != nil {
		return nil, err
	}
	host, port, err := splitAddress(address)
	if err != nil {
		return nil, err
	}
	options := map[string]any{"host": host, "port": port}
	setFamily(options, family)
	listener, err := awaitPromise(d.proxy.Call("listen", js.ValueOf(options)))
	if err != nil {
		return nil, &net.OpError{Op: "listen", Net: network, Err: fmt.Errorf("%s: %w", address, hostNetError(err))}
	}
	return &hostListener{
		network:  network,
		listener: listener,
		addr:     tcpAddrFromJS(listener.Get("local")),
		closed:   make(chan struct{}),
	}, nil
}

func (d hostDriver) dialPacket(ctx context.Context, network, address, localAddr string) (net.Conn, error) {
	family, err := networkFamily(network, "udp")
	if err != nil {
		return nil, err
	}
	host, port, err := splitAddress(address)
	if err != nil {
		return nil, err
	}
	remoteIP, err := d.resolveIP(ctx, dialHost(host), family)
	if err != nil {
		return nil, dialError(network, address, err)
	}
	options := map[string]any{"host": remoteIP, "port": port}
	if localAddr != "" {
		localHost, localPort, err := splitAddress(localAddr)
		if err != nil {
			return nil, err
		}
		if localHost != "" {
			if localHost, err = d.resolveIP(ctx, localHost, family); err != nil {
				return nil, dialError(network, address, err)
			}
		}
		options["localHost"] = localHost
		options["localPort"] = localPort
	}
	if err := ctx.Err(); err != nil {
		return nil, dialError(network, address, err)
	}
	socket, err := awaitPromise(d.proxy.Call("connectDatagram", js.ValueOf(options)))
	if err != nil {
		return nil, dialError(network, address, hostNetError(err))
	}
	return &datagramConn{datagramSocket: newDatagramSocket(network, socket)}, nil
}

func (d hostDriver) listenPacket(network, address string) (net.PacketConn, error) {
	family, err := networkFamily(network, "udp")
	if err != nil {
		return nil, err
	}
	host, port, err := splitAddress(address)
	if err != nil {
		return nil, err
	}
	if host != "" {
		if host, err = d.resolveIP(context.Background(), host, family); err != nil {
			return nil, &net.OpError{Op: "listen", Net: network, Err: err}
		}
	}
	options := map[string]any{"host": host, "port": port}
	setFamily(options, family)
	socket, err := awaitPromise(d.proxy.Call("bindDatagram", js.ValueOf(options)))
	if err != nil {
		return nil, &net.OpError{Op: "listen", Net: network, Err: fmt.Errorf("%s: %w", address, hostNetError(err))}
	}
	return &packetConn{datagramSocket: newDatagramSocket(network, socket)}, nil
}

func (d hostDriver) resolvePacketAddr(network, address string) (net.Addr, error) {
	family, err := networkFamily(network, "udp")
	if err != nil {
		return nil, err
	}
	host, port, err := splitAddress(address)
	if err != nil {
		return nil, err
	}
	if host == "" {
		return &net.UDPAddr{Port: port}, nil
	}
	ip, err := d.resolveIP(context.Background(), host, family)
	if err != nil {
		return nil, err
	}
	return udpAddr(ip, port), nil
}

func (d hostDriver) resolveIP(ctx context.Context, host string, family int) (string, error) {
	if unzoned, _, _ := strings.Cut(host, "%"); net.ParseIP(unzoned) != nil {
		return host, nil
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	addresses, err := d.lookup(ctx, host, family)
	if err != nil {
		return "", err
	}
	first := ""
	for i := 0; i < addresses.Length(); i++ {
		address := addresses.Index(i).String()
		if first == "" {
			first = address
		}
		if ip := net.ParseIP(address); ip != nil && ip.To4() != nil {
			return address, nil
		}
	}
	if first == "" {
		return "", fmt.Errorf("lookup %s: no such host", host)
	}
	return first, nil
}

// lookup returns as soon as ctx ends. The host lookup can't be cancelled and its
// late result is dropped, which is safe because it holds no resources.
func (d hostDriver) lookup(ctx context.Context, host string, family int) (js.Value, error) {
	type result struct {
		addresses js.Value
		err       error
	}
	promise := d.proxy.Call("lookup", host, family)
	done := make(chan result, 1)
	go func() {
		addresses, err := awaitPromise(promise)
		done <- result{addresses, err}
	}()
	select {
	case r := <-done:
		if r.err != nil {
			return js.Value{}, fmt.Errorf("lookup %s: %w", host, hostNetError(r.err))
		}
		return r.addresses, nil
	case <-ctx.Done():
		return js.Value{}, fmt.Errorf("lookup %s: %w", host, ctx.Err())
	}
}

func networkFamily(network, protocol string) (int, error) {
	switch network {
	case protocol:
		return 0, nil
	case protocol + "4":
		return 4, nil
	case protocol + "6":
		return 6, nil
	}
	return 0, net.UnknownNetworkError(network)
}

func setFamily(options map[string]any, family int) {
	if family != 0 {
		options["family"] = family
	}
}

func splitAddress(address string) (string, int, error) {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return "", 0, err
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 0 || port > 65535 {
		return "", 0, &net.AddrError{Err: "invalid port", Addr: address}
	}
	return host, port, nil
}

func dialHost(host string) string {
	if host == "" {
		return "localhost"
	}
	return host
}

func dialError(network, address string, err error) error {
	return &net.OpError{Op: "dial", Net: network, Err: fmt.Errorf("%s: %w", address, err)}
}

func abortSignal(ctx context.Context) (js.Value, func()) {
	done := ctx.Done()
	if done == nil {
		return js.Undefined(), func() {}
	}
	controller := js.Global().Get("AbortController").New()
	finished := make(chan struct{})
	go func() {
		select {
		case <-done:
			controller.Call("abort")
		case <-finished:
		}
	}()
	return controller.Get("signal"), func() { close(finished) }
}

func bytesFromJS(value js.Value) []byte {
	data := make([]byte, value.Get("byteLength").Int())
	js.CopyBytesToGo(data, value)
	return data
}

func bytesToJS(data []byte) js.Value {
	value := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(value, data)
	return value
}

func splitZone(host string) (string, string) {
	ip, zone, _ := strings.Cut(host, "%")
	return ip, zone
}

func udpAddr(host string, port int) *net.UDPAddr {
	ip, zone := splitZone(host)
	return &net.UDPAddr{IP: net.ParseIP(ip), Port: port, Zone: zone}
}

func udpAddrFromJS(value js.Value) *net.UDPAddr {
	return udpAddr(value.Get("host").String(), value.Get("port").Int())
}

func tcpAddrFromJS(value js.Value) *net.TCPAddr {
	ip, zone := splitZone(value.Get("host").String())
	return &net.TCPAddr{IP: net.ParseIP(ip), Port: value.Get("port").Int(), Zone: zone}
}

type socketDeadline struct {
	mu     sync.Mutex
	timer  *time.Timer
	cancel chan struct{}
}

func newSocketDeadline() *socketDeadline {
	return &socketDeadline{cancel: make(chan struct{})}
}

func (d *socketDeadline) set(t time.Time) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.timer != nil && !d.timer.Stop() {
		<-d.cancel
	}
	d.timer = nil

	expired := isClosed(d.cancel)
	if t.IsZero() {
		if expired {
			d.cancel = make(chan struct{})
		}
		return
	}
	if remaining := time.Until(t); remaining > 0 {
		if expired {
			d.cancel = make(chan struct{})
		}
		cancel := d.cancel
		d.timer = time.AfterFunc(remaining, func() { close(cancel) })
		return
	}
	if !expired {
		close(d.cancel)
	}
}

func (d *socketDeadline) wait() <-chan struct{} {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.cancel
}

func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

type socketState struct {
	network    string
	socket     js.Value
	local      net.Addr
	remote     net.Addr
	readLimit  *socketDeadline
	writeLimit *socketDeadline
	closed     chan struct{}
	closeOnce  sync.Once
}

func newSocketState(network string, socket js.Value, local, remote net.Addr) socketState {
	return socketState{
		network:    network,
		socket:     socket,
		local:      local,
		remote:     remote,
		readLimit:  newSocketDeadline(),
		writeLimit: newSocketDeadline(),
		closed:     make(chan struct{}),
	}
}

func (s *socketState) opError(op string, remote net.Addr, err error) error {
	return &net.OpError{Op: op, Net: s.network, Source: s.local, Addr: remote, Err: err}
}

func (s *socketState) markClosed() {
	s.closeOnce.Do(func() {
		close(s.closed)
		s.readLimit.set(time.Time{})
		s.writeLimit.set(time.Time{})
	})
}

func (s *socketState) Close() error {
	if isClosed(s.closed) {
		return s.opError("close", s.remote, net.ErrClosed)
	}
	s.markClosed()
	if _, err := awaitPromise(s.socket.Call("close")); err != nil {
		return s.opError("close", s.remote, hostNetError(err))
	}
	return nil
}

func (s *socketState) LocalAddr() net.Addr { return s.local }

func (s *socketState) SetDeadline(t time.Time) error {
	if err := s.SetReadDeadline(t); err != nil {
		return err
	}
	return s.SetWriteDeadline(t)
}

func (s *socketState) SetReadDeadline(t time.Time) error {
	if isClosed(s.closed) {
		return s.opError("set", s.remote, net.ErrClosed)
	}
	s.readLimit.set(t)
	return nil
}

func (s *socketState) SetWriteDeadline(t time.Time) error {
	if isClosed(s.closed) {
		return s.opError("set", s.remote, net.ErrClosed)
	}
	s.writeLimit.set(t)
	return nil
}

// checkOpen reports why an operation can't start. A blocking select alone is
// not enough: with several channels ready it picks at random, so a closed socket
// or an expired deadline could lose to data that is already available.
func (s *socketState) checkOpen(limit *socketDeadline) error {
	if isClosed(s.closed) {
		return net.ErrClosed
	}
	if isClosed(limit.wait()) {
		return os.ErrDeadlineExceeded
	}
	return nil
}

func (s *socketState) awaitWrite(promise js.Value, release func()) error {
	result := make(chan error, 1)
	go func() {
		defer release()
		_, err := awaitPromise(promise)
		result <- err
	}()
	limit := s.writeLimit.wait()
	select {
	case err := <-result:
		if err != nil {
			if hostErrorCode(err) == closedSocketCode {
				return net.ErrClosed
			}
			return hostNetError(err)
		}
		return nil
	case <-s.closed:
		return net.ErrClosed
	case <-limit:
		return os.ErrDeadlineExceeded
	}
}

type streamConn struct {
	socketState
	chunks  chan []byte
	readErr error

	pendingMu sync.Mutex
	pending   []byte
	writeSlot chan struct{}

	writeAbandoned atomic.Bool
}

func newStreamConn(network string, socket js.Value) *streamConn {
	conn := &streamConn{
		socketState: newSocketState(network, socket, tcpAddrFromJS(socket.Get("local")), tcpAddrFromJS(socket.Get("remote"))),
		chunks:      make(chan []byte),
		writeSlot:   make(chan struct{}, 1),
	}
	go conn.pump()
	return conn
}

func (c *streamConn) pump() {
	defer close(c.chunks)
	for {
		chunk, err := awaitPromise(c.socket.Call("read"))
		if err != nil {
			if hostErrorCode(err) == closedSocketCode {
				c.readErr = net.ErrClosed
			} else {
				c.readErr = hostNetError(err)
			}
			return
		}
		if chunk.IsNull() {
			c.readErr = io.EOF
			return
		}
		select {
		case c.chunks <- bytesFromJS(chunk):
		case <-c.closed:
			c.readErr = net.ErrClosed
			return
		}
	}
}

func (c *streamConn) takePending(p []byte) int {
	c.pendingMu.Lock()
	defer c.pendingMu.Unlock()
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n
}

func (c *streamConn) Read(p []byte) (int, error) {
	if err := c.checkOpen(c.readLimit); err != nil {
		return 0, c.opError("read", c.remote, err)
	}
	if len(p) == 0 {
		return 0, nil
	}
	if n := c.takePending(p); n > 0 {
		return n, nil
	}
	select {
	case chunk, ok := <-c.chunks:
		if !ok {
			if errors.Is(c.readErr, io.EOF) {
				return 0, io.EOF
			}
			return 0, c.opError("read", c.remote, c.readErr)
		}
		n := copy(p, chunk)
		c.pendingMu.Lock()
		c.pending = chunk[n:]
		c.pendingMu.Unlock()
		return n, nil
	case <-c.closed:
		return 0, c.opError("read", c.remote, net.ErrClosed)
	case <-c.readLimit.wait():
		return 0, c.opError("read", c.remote, os.ErrDeadlineExceeded)
	}
}

func (c *streamConn) Write(p []byte) (int, error) {
	if err := c.checkOpen(c.writeLimit); err != nil {
		return 0, c.opError("write", c.remote, err)
	}
	if c.writeAbandoned.Load() {
		return 0, c.opError("write", c.remote, errWriteAbandoned)
	}
	if len(p) == 0 {
		return 0, nil
	}
	select {
	case c.writeSlot <- struct{}{}:
	case <-c.closed:
		return 0, c.opError("write", c.remote, net.ErrClosed)
	case <-c.writeLimit.wait():
		return 0, c.opError("write", c.remote, os.ErrDeadlineExceeded)
	}
	promise := c.socket.Call("write", bytesToJS(p))
	if err := c.awaitWrite(promise, func() { <-c.writeSlot }); err != nil {
		// The host still holds these bytes and may yet send them, so a retry could
		// duplicate data. Refuse further writes, as crypto/tls does after a timeout.
		if errors.Is(err, os.ErrDeadlineExceeded) {
			c.writeAbandoned.Store(true)
		}
		return 0, c.opError("write", c.remote, err)
	}
	return len(p), nil
}

func (c *streamConn) RemoteAddr() net.Addr { return c.remote }

type hostListener struct {
	network   string
	listener  js.Value
	addr      net.Addr
	closed    chan struct{}
	closeOnce sync.Once
}

func (l *hostListener) Accept() (net.Conn, error) {
	if isClosed(l.closed) {
		return nil, l.opError("accept", net.ErrClosed)
	}
	socket, err := awaitPromise(l.listener.Call("accept"))
	if err != nil {
		if hostErrorCode(err) == closedSocketCode {
			return nil, l.opError("accept", net.ErrClosed)
		}
		return nil, l.opError("accept", hostNetError(err))
	}
	return newStreamConn(l.network, socket), nil
}

func (l *hostListener) Close() error {
	err := l.opError("close", net.ErrClosed)
	l.closeOnce.Do(func() {
		close(l.closed)
		err = nil
		if _, closeErr := awaitPromise(l.listener.Call("close")); closeErr != nil {
			err = l.opError("close", hostNetError(closeErr))
		}
	})
	return err
}

func (l *hostListener) Addr() net.Addr { return l.addr }

func (l *hostListener) opError(op string, err error) error {
	return &net.OpError{Op: op, Net: l.network, Addr: l.addr, Err: err}
}

type datagram struct {
	data []byte
	from *net.UDPAddr
	err  error
}

// datagramSocket is a UDP socket on the host. A receive failure is handed out
// once and the next read blocks again; udp:Listener's read loop retries
// immediately on an error, so a repeating one would freeze the event loop.
type datagramSocket struct {
	socketState
	received chan datagram
}

func newDatagramSocket(network string, socket js.Value) *datagramSocket {
	var remote net.Addr
	if value := socket.Get("remote"); value.Type() == js.TypeObject && !value.IsNull() {
		remote = udpAddrFromJS(value)
	}
	conn := &datagramSocket{
		socketState: newSocketState(network, socket, udpAddrFromJS(socket.Get("local")), remote),
		received:    make(chan datagram),
	}
	go conn.pump()
	return conn
}

func (s *datagramSocket) pump() {
	for {
		value, err := awaitPromise(s.socket.Call("receive"))
		var next datagram
		switch {
		case err == nil:
			next = datagram{data: bytesFromJS(value.Get("data")), from: udpAddr(value.Get("host").String(), value.Get("port").Int())}
		case hostErrorCode(err) == closedSocketCode:
			s.markClosed()
			return
		default:
			next = datagram{err: hostNetError(err)}
		}
		select {
		case s.received <- next:
		case <-s.closed:
			return
		}
	}
}

func (s *datagramSocket) receive() (datagram, error) {
	if err := s.checkOpen(s.readLimit); err != nil {
		return datagram{}, err
	}
	select {
	case next := <-s.received:
		return next, next.err
	case <-s.closed:
		return datagram{}, net.ErrClosed
	case <-s.readLimit.wait():
		return datagram{}, os.ErrDeadlineExceeded
	}
}

func (s *datagramSocket) send(data []byte, args ...any) error {
	if err := s.checkOpen(s.writeLimit); err != nil {
		return err
	}
	promise := s.socket.Call("send", append([]any{bytesToJS(data)}, args...)...)
	return s.awaitWrite(promise, func() {})
}

type packetConn struct {
	*datagramSocket
}

func (c *packetConn) ReadFrom(p []byte) (int, net.Addr, error) {
	next, err := c.receive()
	if err != nil {
		return 0, nil, c.opError("read", nil, err)
	}
	return copy(p, next.data), next.from, nil
}

func (c *packetConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	host, port, err := splitAddress(addr.String())
	if err != nil {
		return 0, c.opError("write", addr, err)
	}
	if err := c.send(p, host, port); err != nil {
		return 0, c.opError("write", addr, err)
	}
	return len(p), nil
}

type datagramConn struct {
	*datagramSocket
}

func (c *datagramConn) Read(p []byte) (int, error) {
	next, err := c.receive()
	if err != nil {
		return 0, c.opError("read", c.remote, err)
	}
	return copy(p, next.data), nil
}

func (c *datagramConn) Write(p []byte) (int, error) {
	if err := c.send(p); err != nil {
		return 0, c.opError("write", c.remote, err)
	}
	return len(p), nil
}

func (c *datagramConn) RemoteAddr() net.Addr { return c.remote }
