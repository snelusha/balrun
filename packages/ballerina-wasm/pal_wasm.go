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
	palFS := &palFS{cwd: cwd, fsys: fsys}

	return pal.Platform{
		IO: pal.IO{
			Stdout: stdout.Write,
			Stderr: stderr.Write,
		},
		FS: pal.FS{
			ReadFile:   palFS.readFile,
			WriteFile:  palFS.writeFile,
			AppendFile: palFS.appendFile,
		},
		OS: newPalOS(osProxy),
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
		},
		Signals: signals,
	}
}
