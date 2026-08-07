package main

import (
	"ballerina-lang-go/platform/pal"
	"errors"
	"fmt"
	"syscall/js"
)

type palOS struct {
	proxy js.Value
}

func newPalOS(proxy js.Value) pal.OS {
	os := &palOS{proxy: proxy}
	return pal.OS{
		GetEnv:      os.getEnv,
		GetUsername: os.getUsername,
		GetUserHome: os.getUserHome,
		SetEnv:      os.setEnv,
		UnsetEnv:    os.unsetEnv,
		ListEnv:     os.listEnv,
		Exec:        os.exec,
	}
}

func (o *palOS) call(method string, args ...any) (js.Value, error) {
	if o.proxy.Type() != js.TypeObject || o.proxy.IsNull() {
		return js.Undefined(), fmt.Errorf("OS platform is unavailable")
	}
	if fn := o.proxy.Get(method); fn.Type() != js.TypeFunction {
		return js.Undefined(), fmt.Errorf("OS platform does not implement %q", method)
	}
	return awaitPromise(o.proxy.Call(method, args...))
}

func (o *palOS) getEnv(name string) string {
	result, err := o.call("getEnv", name)
	if err != nil {
		panic(hostError(err))
	}
	return result.String()
}

func (o *palOS) getUsername() string {
	result, err := o.call("getUsername")
	if err != nil {
		panic(hostError(err))
	}
	return result.String()
}

func (o *palOS) getUserHome() string {
	result, err := o.call("getUserHome")
	if err != nil {
		panic(hostError(err))
	}
	return result.String()
}

func (o *palOS) setEnv(key, value string) error {
	_, err := o.call("setEnv", key, value)
	return hostError(err)
}

func (o *palOS) unsetEnv(key string) error {
	_, err := o.call("unsetEnv", key)
	return hostError(err)
}

func (o *palOS) listEnv() map[string]string {
	result, err := o.call("listEnv")
	if err != nil {
		panic(hostError(err))
	}
	env := make(map[string]string)
	keys := js.Global().Get("Object").Call("keys", result)
	for i := 0; i < keys.Length(); i++ {
		key := keys.Index(i).String()
		env[key] = result.Get(key).String()
	}
	return env
}

func (o *palOS) exec(command string, args []string, envOverride map[string]string) (pal.ProcessHandle, error) {
	jsArgs := js.Global().Get("Array").New(len(args))
	for i, arg := range args {
		jsArgs.SetIndex(i, arg)
	}
	jsEnv := js.Global().Get("Object").New()
	for key, value := range envOverride {
		jsEnv.Set(key, value)
	}
	process, err := o.call("exec", command, jsArgs, jsEnv)
	if err != nil {
		return nil, hostError(err)
	}
	return &palProcess{proxy: process}, nil
}

func hostError(err error) error {
	if err == nil {
		return nil
	}

	if jsError, ok := errors.AsType[js.Error](err); ok {
		message := jsError.Value.Get("message")
		if message.Type() == js.TypeString {
			return errors.New(message.String())
		}
	}
	return err
}

type palProcess struct {
	proxy js.Value
}

func (p *palProcess) WaitForExit() (int, error) {
	result, err := p.call("waitForExit")
	if err != nil {
		return -1, hostError(err)
	}
	return result.Int(), nil
}

func (p *palProcess) ReadStdout() ([]byte, error) {
	return p.read("readStdout")
}

func (p *palProcess) ReadStderr() ([]byte, error) {
	return p.read("readStderr")
}

func (p *palProcess) Kill() {
	p.proxy.Call("kill")
}

func (p *palProcess) call(method string) (js.Value, error) {
	return awaitPromise(p.proxy.Call(method))
}

func (p *palProcess) read(method string) ([]byte, error) {
	result, err := p.call(method)
	if err != nil {
		return nil, hostError(err)
	}
	if result.Get("byteLength").Type() != js.TypeNumber {
		return nil, fmt.Errorf("process output is not a byte array")
	}
	data := make([]byte, result.Get("byteLength").Int())
	js.CopyBytesToGo(data, result)
	return data, nil
}
