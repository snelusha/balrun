package main

import (
	"ballerina/platform/pal"
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"syscall/js"
)

type wasmListenerHandle struct {
	host      string
	port      int
	transport js.Value
}

func (h *wasmListenerHandle) Shutdown(ctx context.Context) error {
	return h.close("graceful")
}

func (h *wasmListenerHandle) Close() error {
	return h.close("immediate")
}

func (h *wasmListenerHandle) close(mode string) error {
	config := js.ValueOf(map[string]any{"host": h.host, "port": h.port})
	_, err := awaitPromise(h.transport.Call("close", config, mode))
	if err != nil {
		return err
	}
	activeRunContext.unregisterHandler(h.host, h.port)
	return nil
}

func listenerKey(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}

func listen(transport js.Value, cfg pal.ServerConfig, handler http.Handler) (pal.ServerHandle, error) {
	if transport.IsUndefined() || transport.IsNull() || transport.Get("listen").Type() != js.TypeFunction {
		return nil, fmt.Errorf("HTTP listeners are unavailable in this environment")
	}
	if cfg.TLS != nil {
		return nil, fmt.Errorf("HTTP listener TLS is not supported by the WASM host")
	}
	if err := activeRunContext.registerHandler(cfg.Host, cfg.Port, handler); err != nil {
		return nil, err
	}
	config := js.ValueOf(map[string]any{"host": cfg.Host, "port": cfg.Port})
	if _, err := awaitPromise(transport.Call("listen", config)); err != nil {
		activeRunContext.unregisterHandler(cfg.Host, cfg.Port)
		return nil, err
	}
	return &wasmListenerHandle{host: cfg.Host, port: cfg.Port, transport: transport}, nil
}
