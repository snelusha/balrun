package main

import (
	"io"
	"syscall/js"
)

type jsStreamWriter struct {
	v js.Value
}

func (w jsStreamWriter) Write(p []byte) (n int, err error) {
	if len(p) == 0 {
		return 0, nil
	}
	w.v.Call("write", string(p))
	return len(p), nil
}

func streamWriterFromJS(v js.Value) io.Writer {
	if v.IsUndefined() || v.IsNull() {
		return nil
	}
	if t := v.Type(); t != js.TypeObject && t != js.TypeFunction {
		return nil
	}
	write := v.Get("write")
	if write.IsUndefined() || write.Type() != js.TypeFunction {
		return nil
	}
	return jsStreamWriter{v: v}
}
