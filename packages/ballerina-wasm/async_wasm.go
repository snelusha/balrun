package main

import "syscall/js"

type jsResult struct {
	value js.Value
	err   error
}

func await(promise js.Value) (js.Value, error) {
	ch := make(chan jsResult, 1)

	thenFunc := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		ch <- jsResult{value: args[0]}
		return nil
	})
	defer thenFunc.Release()

	catchFunc := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		ch <- jsResult{err: js.Error{Value: args[0]}}
		return nil
	})
	defer catchFunc.Release()

	promise.Call("then", thenFunc).Call("catch", catchFunc)

	r := <-ch
	return r.value, r.err
}
