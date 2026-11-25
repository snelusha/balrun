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

func hasMethod(value js.Value, method string) bool {
	return value.Get(method).Type() == js.TypeFunction
}

func callMethod(value js.Value, method string, args ...any) (js.Value, error) {
	res, err := tryCall(value, method, args...)
	if err != nil {
		return js.Undefined(), err
	}
	return awaitPromise(res)
}

func tryCall(value js.Value, method string, args ...any) (res js.Value, err error) {
	defer func() {
		if r := recover(); r != nil {
			jsErr, ok := r.(js.Error)
			if !ok {
				panic(r)
			}
			err = jsErr
		}
	}()
	return value.Call(method, args...), nil
}

func awaitPromise(promise js.Value) (js.Value, error) {
	if promise.Type() != js.TypeObject || !hasMethod(promise, "then") {
		return promise, nil
	}

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

	if _, err := tryCall(promise, "then", thenFunc, catchFunc); err != nil {
		release()
		return js.Undefined(), err
	}

	r := <-ch
	return r.value, r.err
}
