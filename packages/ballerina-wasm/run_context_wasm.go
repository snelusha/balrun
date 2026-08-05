package main

import (
	"ballerina-lang-go/platform/pal"
	"ballerina-lang-go/runtime"
	"fmt"
	"net/http"
	"sync"
)

type runContext struct {
	mu sync.Mutex

	rt       *runtime.Runtime
	signals  *signalSource
	handlers map[string]http.Handler
}

var activeRunContext = &runContext{}

func (rc *runContext) begin(signals *signalSource) bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.signals != nil || rc.rt != nil {
		return false
	}
	rc.signals = signals
	rc.handlers = make(map[string]http.Handler)
	return true
}

func (rc *runContext) end(signals *signalSource) bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.signals != signals {
		return false
	}
	rc.rt = nil
	rc.signals = nil
	rc.handlers = nil
	signals.cleanup()
	return true
}

func (rc *runContext) setRuntime(signals *signalSource, rt *runtime.Runtime) bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.signals != signals {
		return false
	}
	rc.rt = rt
	return true
}

func (rc *runContext) registerHandler(host string, port int, handler http.Handler) error {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.handlers == nil {
		return fmt.Errorf("no Ballerina runtime is active")
	}
	key := listenerKey(host, port)
	if _, exists := rc.handlers[key]; exists {
		return fmt.Errorf("HTTP listener is already registered on %s", key)
	}
	rc.handlers[key] = handler
	return nil
}

func (rc *runContext) unregisterHandler(host string, port int) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	delete(rc.handlers, listenerKey(host, port))
}

func (rc *runContext) handler(host string, port int) (http.Handler, bool) {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	handler, ok := rc.handlers[listenerKey(host, port)]
	return handler, ok
}

func (rc *runContext) sendSignal(sig pal.Signal) bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.signals == nil {
		return false
	}
	return rc.signals.send(sig)
}
