package main

import (
	"io"
	"net/http"
	"syscall/js"
	"time"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

var processStart = time.Now()

func newPal(cwd string, fsys *bridgeFS, stdout, stderr io.Writer, signals pal.SignalSource, httpListenerTransport, osProxy js.Value) pal.Platform {
	palOS := newPalOS(osProxy)

	return pal.Platform{
		IO: pal.IO{
			Stdout: stdout.Write,
			Stderr: stderr.Write,
		},
		FS: newPalFS(cwd, fsys, palOS.GetEnv),
		OS: palOS,
		HTTP: pal.HTTP{
			NewClient: func(cfg pal.ClientConfig) (pal.HTTPClient, error) {
				return &fetchHTTPClient{cfg: cfg}, nil
			},
			Listen: func(cfg pal.ServerConfig, handler http.Handler) (pal.ServerHandle, error) {
				return listen(httpListenerTransport, cfg, handler)
			},
		},
		Time: pal.Time{
			Now:          time.Now,
			MonotonicNow: func() time.Duration { return time.Since(processStart) },
			AfterFunc:    func(d time.Duration, f func()) pal.Timer { return time.AfterFunc(d, f) },
		},
		Signals: signals,
	}
}
