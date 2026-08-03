package main

import (
	"ballerina-lang-go/platform/pal"
	"sync"
)

type signalSource struct {
	mu sync.Mutex
	ch chan pal.Signal
}

func (s *signalSource) send(sig pal.Signal) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	select {
	case s.ch <- sig:
		return true
	default:
		return false
	}
}

func (s *signalSource) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()
	close(s.ch)
}

func newSignalSource() (*signalSource, pal.SignalSource) {
	ch := make(chan pal.Signal, 2)
	return &signalSource{ch: ch}, pal.SignalSource{
		Signals: ch,
	}
}
