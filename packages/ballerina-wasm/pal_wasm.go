package main

import (
	"ballerina-lang-go/platform/pal"
	"fmt"
	"io"
	"strings"
	"syscall/js"
	"time"
)

type fetchHTTPClient struct {
	cfg pal.ClientConfig
}

type requestContext struct {
	abortController js.Value
	timeout         *time.Timer
}

func (ctx *requestContext) cleanup() {
	if ctx.timeout != nil {
		ctx.timeout.Stop()
	}
}

func (c *fetchHTTPClient) Execute(method, url string, body []byte, contentType string, reqHeaders map[string][]string) (int, map[string][]string, []byte, error) {
	fetch := js.Global().Get("fetch")
	if !fetch.Truthy() {
		return 0, nil, nil, fmt.Errorf("browser fetch API is not available")
	}

	reqCtx := &requestContext{}
	defer reqCtx.cleanup()

	options, err := c.buildFetchOptions(method, body, contentType, reqHeaders, reqCtx)
	if err != nil {
		return 0, nil, nil, err
	}

	resp, err := c.executeRequest(fetch, url, options)
	if err != nil {
		return 0, nil, nil, err
	}

	status := resp.Get("status").Int()
	respHeaders := c.extractHeaders(resp)
	respBody, err := c.extractBody(resp)
	if err != nil {
		return status, respHeaders, nil, err
	}

	return status, respHeaders, respBody, nil
}

func (c *fetchHTTPClient) buildFetchOptions(method string, body []byte, contentType string, reqHeaders map[string][]string, reqCtx *requestContext) (map[string]any, error) {
	options := map[string]any{
		"method":   method,
		"headers":  c.buildHeaders(contentType, reqHeaders),
		"redirect": c.getRedirectMode(),
	}

	if body != nil && c.methodAllowsBody(method) {
		options["body"] = c.encodeBody(body)
	}

	if c.cfg.Timeout > 0 {
		signal, err := c.setupTimeout(reqCtx)
		if err != nil {
			return options, err
		}
		options["signal"] = signal
	}

	return options, nil
}

func (c *fetchHTTPClient) methodAllowsBody(method string) bool {
	m := strings.ToUpper(method)
	return m != "GET" && m != "HEAD"
}

func (c *fetchHTTPClient) getRedirectMode() string {
	if c.cfg.FollowRedirects.Enabled {
		return "follow"
	}
	return "manual"
}

func (c *fetchHTTPClient) buildHeaders(contentType string, reqHeaders map[string][]string) js.Value {
	headers := js.Global().Get("Headers").New()

	for name, values := range reqHeaders {
		if len(values) == 0 {
			continue
		}
		headers.Call("set", name, values[0])
		for _, value := range values[1:] {
			headers.Call("append", name, value)
		}
	}

	if contentType != "" {
		headers.Call("set", "Content-Type", contentType)
	}

	return headers
}

func (c *fetchHTTPClient) encodeBody(body []byte) js.Value {
	uint8Array := js.Global().Get("Uint8Array").New(len(body))
	js.CopyBytesToJS(uint8Array, body)
	return uint8Array
}

func (c *fetchHTTPClient) setupTimeout(reqCtx *requestContext) (js.Value, error) {
	abortController := js.Global().Get("AbortController")
	if !abortController.Truthy() {
		return js.Undefined(), fmt.Errorf("AbortController API is not available")
	}

	controller := abortController.New()
	if !controller.Truthy() {
		return js.Undefined(), fmt.Errorf("failed to create AbortController")
	}

	reqCtx.abortController = controller
	reqCtx.timeout = time.AfterFunc(c.cfg.Timeout, func() {
		controller.Call("abort")
	})

	return controller.Get("signal"), nil
}

func (c *fetchHTTPClient) executeRequest(fetch js.Value, url string, options map[string]any) (js.Value, error) {
	return awaitPromise(fetch.Invoke(url, js.ValueOf(options)))
}

func (c *fetchHTTPClient) extractHeaders(resp js.Value) map[string][]string {
	headers := make(map[string][]string)
	headersObj := resp.Get("headers")

	forEach := js.FuncOf(func(_ js.Value, args []js.Value) any {
		if len(args) < 2 {
			return nil
		}
		value := args[0].String()
		name := args[1].String()
		headers[name] = append(headers[name], value)
		return nil
	})
	defer forEach.Release()

	headersObj.Call("forEach", forEach)
	return headers
}

func (c *fetchHTTPClient) extractBody(resp js.Value) ([]byte, error) {
	arrayBuffer, err := awaitPromise(resp.Call("arrayBuffer"))
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	uint8Array := js.Global().Get("Uint8Array").New(arrayBuffer)
	bodyLen := uint8Array.Get("byteLength").Int()

	body := make([]byte, bodyLen)
	js.CopyBytesToGo(body, uint8Array)

	return body, nil
}

func newPal(stdout, stderr io.Writer) pal.Platform {
	return pal.Platform{
		IO: pal.IO{
			Stdout: stdout.Write,
			Stderr: stderr.Write,
		},
		HTTP: pal.HTTP{
			NewClient: func(cfg pal.ClientConfig) pal.HTTPClient {
				return &fetchHTTPClient{cfg: cfg}
			},
		},
	}
}
