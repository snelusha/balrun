package main

import (
	"context"
	"errors"
	"os"
	"strings"
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
