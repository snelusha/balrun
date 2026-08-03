package main

import (
	"ballerina-lang-go/platform/pal"
	"ballerina-lang-go/runtime"
	"sync"
)

type runContext struct {
	mu sync.Mutex

	rt      *runtime.Runtime
	signals *signalSource
}

var activeRunContext = &runContext{}

func (rc *runContext) begin(signals *signalSource) bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.signals != nil || rc.rt != nil {
		return false
	}
	rc.signals = signals
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

func (rc *runContext) sendSignal(sig pal.Signal) bool {
	rc.mu.Lock()
	defer rc.mu.Unlock()
	if rc.signals == nil {
		return false
	}
	return rc.signals.send(sig)
}
