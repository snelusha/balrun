package main

import (
	"context"
	"errors"
	"net"
	"os"
	"syscall/js"
	"testing"
	"time"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

// evalJS builds a fake host object, so these tests reach the Go side of the bridge directly.
func evalJS(source string) js.Value {
	return js.Global().Get("Function").New("return (" + source + ")").Invoke()
}

const fakeHandle = `{
	calls: [],
	closes: 0,
	close() { this.closes++; return Promise.resolve(); },
	setReadDeadline(ms) { this.calls.push(["read", ms]); return !this.closed; },
	setWriteDeadline(ms) { this.calls.push(["write", ms]); return !this.closed; },
	localAddress() { return { address: "127.0.0.1", port: 1 }; },
	remoteAddress() { return { address: "::1", port: 2 }; },
}`

func TestUnavailableInBrowser(t *testing.T) {
	n := newPalNet(js.Undefined())
	if _, err := n.Dial(context.Background(), "tcp", "a:1", "", nil); !errors.Is(err, errNetUnavailable) {
		t.Fatalf("got %v", err)
	}
	if _, err := n.ListenPacket("udp", ":0"); !errors.Is(err, errNetUnavailable) {
		t.Fatalf("got %v", err)
	}
}

func TestDialMarshalsTLSOptions(t *testing.T) {
	proxy := evalJS(`{ dial(n, a, l, tls) { this.tls = tls; return Promise.resolve(` + fakeHandle + `); } }`)
	n := newPalNet(proxy)
	for _, cfg := range []*pal.TLSConfig{
		{},
		{CipherSuiteNames: []string{"TLS_RSA_WITH_AES_128_GCM_SHA256"}, HandshakeTimeout: 2 * time.Second, MinVersion: 0x0303},
	} {
		if _, err := n.Dial(context.Background(), "tcp", "a:1", "", cfg); err != nil {
			t.Fatal(err)
		}
	}
	tls := proxy.Get("tls")
	if got := tls.Get("cipherSuites").Index(0).String(); got != "TLS_RSA_WITH_AES_128_GCM_SHA256" {
		t.Fatalf("cipherSuites = %q", got)
	}
	if got := tls.Get("handshakeTimeoutMillis").Int(); got != 2000 {
		t.Fatalf("handshakeTimeoutMillis = %d", got)
	}
}

func TestListenMarshalsServerTLSOptions(t *testing.T) {
	proxy := evalJS(`{ listen() { return Promise.resolve(` + fakeHandle + `); } }`)
	cfg := &pal.ServerTLSConfig{CipherSuiteNames: []string{"x"}}
	if _, err := newPalNet(proxy).Listen("tcp", ":0", cfg); err != nil {
		t.Fatal(err)
	}
}

func TestDialContextAbortsHost(t *testing.T) {
	proxy := evalJS(`{ dial(n, a, l, tls, signal) {
		return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
	} }`)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := newPalNet(proxy).Dial(ctx, "tcp", "a:1", "", nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("got %v", err)
	}
}

func TestDialClosesHandleThatArrivesAfterCancel(t *testing.T) {
	proxy := evalJS(`{
		handle: ` + fakeHandle + `,
		dialPacket(n, a, l, signal) {
			return new Promise((resolve) => signal.addEventListener("abort", () => resolve(this.handle)));
		},
	}`)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(10*time.Millisecond, cancel)
	if _, err := newPalNet(proxy).DialPacket(ctx, "udp", "a:1", ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
	if got := proxy.Get("handle").Get("closes").Int(); got != 1 {
		t.Fatalf("closes = %d", got)
	}
}

func TestHostErrorCodes(t *testing.T) {
	proxy := evalJS(`{
		code: "",
		read() { return Promise.reject(Object.assign(new Error("boom"), { code: this.code })); },
		setReadDeadline() { return true; },
	}`)
	conn := &wasmConn{netHandle{proxy, "tcp"}}
	read := func(code string) error {
		proxy.Set("code", code)
		_, err := conn.Read(make([]byte, 1))
		return err
	}

	if err := read(netClosedCode); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("closed: %v", err)
	}
	for _, code := range []string{netTimeoutCode, "ETIMEDOUT"} {
		err := read(code)
		var netErr net.Error
		if !errors.As(err, &netErr) || !netErr.Timeout() || !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("%s: %v", code, err)
		}
	}
	err := read("ECONNRESET")
	var netErr net.Error
	if errors.As(err, &netErr) || err.Error() != "boom" {
		t.Fatalf("other: %v", err)
	}
}

func TestDeadlinesForwardAndReportClosed(t *testing.T) {
	proxy := evalJS(fakeHandle)
	conn := &wasmConn{netHandle{proxy, "tcp"}}
	deadline := time.UnixMilli(1234)

	if err := conn.SetDeadline(deadline); err != nil {
		t.Fatal(err)
	}
	calls := proxy.Get("calls")
	if calls.Length() != 2 || calls.Index(0).Index(1).Int() != 1234 || calls.Index(1).Index(0).String() != "write" {
		t.Fatalf("unexpected calls")
	}
	if err := conn.SetReadDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	if !calls.Index(2).Index(1).IsUndefined() {
		t.Fatalf("zero time should clear the deadline")
	}

	proxy.Set("closed", true)
	if err := conn.SetReadDeadline(deadline); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("got %v", err)
	}
	if err := conn.SetDeadline(deadline); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("got %v", err)
	}
}

func TestAddresses(t *testing.T) {
	proxy := evalJS(fakeHandle)
	conn := &wasmConn{netHandle{proxy, "tcp"}}
	if got := conn.RemoteAddr(); got.Network() != "tcp" || got.String() != "[::1]:2" {
		t.Fatalf("remote = %v %v", got.Network(), got)
	}
	if got := (&wasmPacket{netHandle{proxy, "udp"}, true}).RemoteAddr(); got.Network() != "udp" {
		t.Fatalf("connected remote = %v", got)
	}
	if got := (&wasmPacket{netHandle{proxy, "udp"}, false}).RemoteAddr(); got != nil {
		t.Fatalf("unconnected remote = %v", got)
	}
}

func TestWriteToValidatesAddress(t *testing.T) {
	proxy := evalJS(`{ writeTo(data, address) { this.address = address; return Promise.resolve(data.length); } }`)
	connected := &wasmPacket{netHandle{proxy, "udp"}, true}
	if _, err := connected.WriteTo([]byte("x"), wasmAddr{"udp", "1.2.3.4:5"}); !errors.Is(err, net.ErrWriteToConnected) {
		t.Fatalf("connected: %v", err)
	}

	unconnected := &wasmPacket{netHandle{proxy, "udp"}, false}
	for _, addr := range []net.Addr{nil, wasmAddr{"unknown", ""}, wasmAddr{"udp", "host:port"}} {
		if _, err := unconnected.WriteTo([]byte("x"), addr); err == nil {
			t.Fatalf("expected an error for %v", addr)
		}
	}
	n, err := unconnected.WriteTo([]byte("xy"), wasmAddr{"udp", "1.2.3.4:5"})
	if err != nil || n != 2 || proxy.Get("address").Get("port").Int() != 5 {
		t.Fatalf("n=%d err=%v", n, err)
	}
}
