package main

import (
	"sync"
	"syscall/js"
)

func newPromise(fn func(resolve, reject js.Value)) js.Value {
	var handler js.Func
	handler = js.FuncOf(func(_ js.Value, args []js.Value) any {
		resolve, reject := args[0], args[1]
		go func() {
			defer handler.Release()
			fn(resolve, reject)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

type awaitResult struct {
	value js.Value
	err   error
}

func awaitPromise(promise js.Value) (js.Value, error) {
	ch := make(chan awaitResult, 1)

	var (
		thenFunc  js.Func
		catchFunc js.Func
		once      sync.Once
	)

	release := func() {
		once.Do(func() {
			thenFunc.Release()
			catchFunc.Release()
		})
	}

	thenFunc = js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer release()
		ch <- awaitResult{value: args[0]}
		return nil
	})

	catchFunc = js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer release()
		ch <- awaitResult{err: js.Error{Value: args[0]}}
		return nil
	})

	promise.Call("then", thenFunc).Call("catch", catchFunc)

	r := <-ch
	return r.value, r.err
}
