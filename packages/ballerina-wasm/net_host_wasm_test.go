package main

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"net"
	"os"
	"strings"
	"syscall"
	"syscall/js"
	"testing"
	"time"
)

func jsObject(methods map[string]func(args []js.Value) any) js.Value {
	object := js.Global().Get("Object").New()
	for name, method := range methods {
		object.Set(name, js.FuncOf(func(_ js.Value, args []js.Value) any { return method(args) }))
	}
	return object
}

func resolved(value any) js.Value {
	return js.Global().Get("Promise").Call("resolve", value)
}

func rejected(message string) js.Value {
	return js.Global().Get("Promise").Call("reject", js.Global().Get("Error").New(message))
}

func neverSettles() js.Value {
	return js.Global().Get("Promise").New(js.FuncOf(func(js.Value, []js.Value) any { return nil }))
}

func TestDialResolvesLocalHost(t *testing.T) {
	var localHost string
	driver := hostDriver{proxy: jsObject(map[string]func([]js.Value) any{
		"lookup": func([]js.Value) any { return resolved(js.ValueOf([]any{"127.0.0.1"})) },
		"connect": func(args []js.Value) any {
			localHost = args[0].Get("localHost").String()
			return rejected("stop here")
		},
	})}
	if _, err := driver.dial(context.Background(), "tcp", "127.0.0.1:1", "localhost:0"); err == nil {
		t.Fatal("expected the fake connect to fail")
	}
	if localHost != "127.0.0.1" {
		t.Fatalf("localHost = %q, want an IP", localHost)
	}
}

func TestLookupStopsWithContext(t *testing.T) {
	driver := hostDriver{proxy: jsObject(map[string]func([]js.Value) any{
		"lookup": func([]js.Value) any { return neverSettles() },
	})}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := driver.resolveIP(ctx, "example.com", 0); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v, want the context deadline", err)
	}
}

func TestWriteIsRefusedAfterTimeout(t *testing.T) {
	writes := 0
	address := map[string]any{"host": "127.0.0.1", "port": 1}
	socket := jsObject(map[string]func([]js.Value) any{
		"read": func([]js.Value) any { return neverSettles() },
		"write": func([]js.Value) any {
			writes++
			return neverSettles()
		},
	})
	socket.Set("local", address)
	socket.Set("remote", address)
	conn := newStreamConn("tcp", socket)

	if err := conn.SetWriteDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write([]byte("data")); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("first write: %v, want a timeout", err)
	}
	if err := conn.SetWriteDeadline(time.Time{}); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write([]byte("data")); !errors.Is(err, errWriteAbandoned) {
		t.Fatalf("retry: %v, want it refused", err)
	}
	if writes != 1 {
		t.Fatalf("host got %d writes, want 1", writes)
	}
}

func TestLoopbackDriverChecksLocalAddress(t *testing.T) {
	driver := loopbackDriver{}
	ctx := context.Background()

	conn, err := driver.dialPacket(ctx, "udp", "127.0.0.1:19999", "localhost:0")
	if err != nil {
		t.Fatalf("localhost as the local address: %v", err)
	}
	_ = conn.Close()

	for _, dial := range []func() error{
		func() error { _, err := driver.dial(ctx, "tcp", "127.0.0.1:1", "192.0.2.1:0"); return err },
		func() error { _, err := driver.dialPacket(ctx, "udp", "127.0.0.1:1", "192.0.2.1:0"); return err },
	} {
		if err := dial(); err == nil || !strings.Contains(err.Error(), "sockets are unavailable") {
			t.Fatalf("non-loopback local address: %v", err)
		}
	}
}

func TestHostErrorsKeepIdentity(t *testing.T) {
	failed := func(code string) error {
		value := js.Global().Get("Error").New("host message")
		value.Set("code", code)
		_, err := awaitPromise(js.Global().Get("Promise").Call("reject", value))
		return dialError("tcp", "127.0.0.1:1", hostNetError(err))
	}

	refused := failed("ECONNREFUSED")
	if !errors.Is(refused, syscall.ECONNREFUSED) {
		t.Fatalf("%v is not ECONNREFUSED", refused)
	}
	if want := "dial tcp: 127.0.0.1:1: connection refused"; refused.Error() != want {
		t.Fatalf("text = %q, want %q", refused, want)
	}
	var opError *net.OpError
	if !errors.As(failed("ETIMEDOUT"), &opError) || !opError.Timeout() {
		t.Fatalf("ETIMEDOUT should be a timeout: %v", opError)
	}
	if !errors.As(refused, &opError) || opError.Timeout() {
		t.Fatalf("ECONNREFUSED shouldn't be a timeout: %v", opError)
	}
}

func TestListenResolvesHostForFamily(t *testing.T) {
	var host string
	var family int
	driver := hostDriver{proxy: jsObject(map[string]func([]js.Value) any{
		"lookup": func(args []js.Value) any {
			family = args[1].Int()
			return resolved(js.ValueOf([]any{"127.0.0.1"}))
		},
		"listen": func(args []js.Value) any {
			host = args[0].Get("host").String()
			return rejected("stop here")
		},
	})}
	if _, err := driver.listen("tcp4", "localhost:9000"); err == nil {
		t.Fatal("expected the fake listen to fail")
	}
	if host != "127.0.0.1" || family != 4 {
		t.Fatalf("host = %q, lookup family = %d", host, family)
	}
	for network, address := range map[string]string{"tcp4": "[::1]:9000", "tcp6": "127.0.0.1:9000"} {
		if _, err := driver.listen(network, address); err == nil || !strings.Contains(err.Error(), "no suitable address") {
			t.Fatalf("%s on %s: %v", network, address, err)
		}
	}
}

type closerFunc func() error

func (f closerFunc) Close() error { return f() }

func TestCloseAllSurvivesBadSockets(t *testing.T) {
	original := socketCloseTimeout
	socketCloseTimeout = 50 * time.Millisecond
	defer func() { socketCloseTimeout = original }()

	closed := make(chan struct{})
	registry := newSocketRegistry()
	for _, socket := range []closerFunc{
		func() error { panic("close threw") },
		func() error { select {} },
		func() error { close(closed); return nil },
	} {
		if err := registry.register(socket, &socket); err != nil {
			t.Fatal(err)
		}
	}
	registry.closeAll()
	select {
	case <-closed:
	default:
		t.Fatal("a healthy socket wasn't closed")
	}
}

func TestTLSHelpersMatchUpstream(t *testing.T) {
	const upstream = "ballerina/platform/palnative/"
	copied := map[string]string{
		"tlsClientHandshake":                upstream + "tls.go",
		"buildTLSConfig":                    upstream + "tls.go",
		"buildServerTLSConfig":              upstream + "httpserver.go",
		"resolveCipherSuites":               upstream + "http.go",
		"tlsVerifyChain":                    upstream + "http.go",
		"tlsVerifyConnectionWithCNFallback": upstream + "http.go",
		"tlsMatchCN":                        upstream + "http.go",
	}
	for name, path := range copied {
		if ours, theirs := funcSource(t, "tls_wasm.go", name), funcSource(t, path, name); ours != theirs {
			t.Errorf("%s differs from %s; copy the upstream version into tls_wasm.go", name, path)
		}
	}
}

func funcSource(t *testing.T, path, name string) string {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Name.Name == name {
			var source strings.Builder
			if err := printer.Fprint(&source, fset, fn); err != nil {
				t.Fatal(err)
			}
			return source.String()
		}
	}
	t.Fatalf("%s has no function %s", path, name)
	return ""
}
