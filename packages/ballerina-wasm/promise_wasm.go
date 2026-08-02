// Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

package main

import (
	"syscall/js"
)

type promiseResult struct {
	value js.Value
	err   error
}

func newPromise(fn func(resolve, reject js.Value)) js.Value {
	var handler js.Func
	handler = js.FuncOf(func(_ js.Value, args []js.Value) any {
		go func() {
			defer handler.Release()
			fn(args[0], args[1])
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func awaitPromise(promise js.Value) (js.Value, error) {
	ch := make(chan promiseResult, 1)

	resolve := js.FuncOf(func(_ js.Value, args []js.Value) any {
		ch <- promiseResult{value: args[0]}
		return nil
	})
	defer resolve.Release()

	reject := js.FuncOf(func(_ js.Value, args []js.Value) any {
		ch <- promiseResult{err: js.Error{Value: args[0]}}
		return nil
	})
	defer reject.Release()

	promise.Call("then", resolve, reject)

	result := <-ch
	return result.value, result.err
}
