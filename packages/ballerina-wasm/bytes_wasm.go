package main

import (
	"errors"
	"syscall/js"
)

var errNotBytes = errors.New("expected a Uint8Array")

func bytesToJS(data []byte) js.Value {
	array := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(array, data)
	return array
}

func bytesFromJS(value js.Value) ([]byte, error) {
	if !value.InstanceOf(js.Global().Get("Uint8Array")) {
		return nil, errNotBytes
	}
	data := make([]byte, value.Get("byteLength").Int())
	js.CopyBytesToGo(data, value)
	return data, nil
}
