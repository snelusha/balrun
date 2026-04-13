package main

import (
	"io"
	"os"
	"syscall/js"
)

// jsCallbackWriter forwards writes to a JavaScript object with write(string).
type jsCallbackWriter struct {
	v js.Value
}

func (w jsCallbackWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	w.v.Call("write", string(p))
	return len(p), nil
}

func writerFromSinkField(opts js.Value, key string, fallback io.Writer) io.Writer {
	if opts.IsNull() || opts.IsUndefined() {
		return fallback
	}
	v := opts.Get(key)
	if v.IsNull() || v.IsUndefined() {
		return fallback
	}
	return jsCallbackWriter{v: v}
}

// parseRunWriters reads the third run() argument: either legacy boolean (colors)
// or an options object { colors, stdout?, stderr? } with JS write sinks.
func parseRunWriters(opts js.Value) (stdout, stderr io.Writer, noColors bool) {
	stdout = os.Stdout
	stderr = os.Stderr
	noColors = false

	if opts.IsNull() || opts.IsUndefined() {
		return stdout, stderr, noColors
	}

	if opts.Type() == js.TypeBoolean {
		noColors = !opts.Bool()
		return stdout, stderr, noColors
	}

	if opts.Type() != js.TypeObject {
		return stdout, stderr, noColors
	}

	colors := opts.Get("colors")
	if !colors.IsUndefined() && colors.Type() == js.TypeBoolean {
		noColors = !colors.Bool()
	}

	stdout = writerFromSinkField(opts, "stdout", os.Stdout)
	stderr = writerFromSinkField(opts, "stderr", os.Stderr)
	return stdout, stderr, noColors
}
