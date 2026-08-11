package main

import (
	"ballerina/platform/pal"
	"bytes"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"
	"syscall/js"
	"time"
)

type fetchHTTPClient struct {
	cfg pal.ClientConfig
}

type requestContext struct {
	done    chan struct{}
	timeout *time.Timer
}

func (ctx *requestContext) cleanup() {
	if ctx.timeout != nil {
		ctx.timeout.Stop()
	}
	close(ctx.done)
}

func (c *fetchHTTPClient) Execute(ctx context.Context, method, url string, body io.Reader, _ int64, contentType string, reqHeaders map[string][]string) (int, map[string][]string, io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return 0, nil, nil, err
	}

	fetch := js.Global().Get("fetch")
	if !fetch.Truthy() {
		return 0, nil, nil, fmt.Errorf("browser fetch API is not available")
	}

	bodyBytes, err := readRequestBody(method, body)
	if err != nil {
		return 0, nil, nil, err
	}
	if err := ctx.Err(); err != nil {
		return 0, nil, nil, err
	}

	reqCtx := &requestContext{done: make(chan struct{})}
	defer reqCtx.cleanup()

	options, err := c.buildFetchOptions(ctx, method, bodyBytes, contentType, reqHeaders, reqCtx)
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

	return status, respHeaders, io.NopCloser(bytes.NewReader(respBody)), nil
}

func readRequestBody(method string, body io.Reader) ([]byte, error) {
	if body == nil || !methodAllowsBody(method) {
		return nil, nil
	}
	data, err := io.ReadAll(body)
	if err != nil {
		return nil, fmt.Errorf("failed to read request body: %w", err)
	}
	return data, nil
}

func (c *fetchHTTPClient) buildFetchOptions(ctx context.Context, method string, body []byte, contentType string, reqHeaders map[string][]string, reqCtx *requestContext) (map[string]any, error) {
	redirect, err := c.getRedirectMode()
	if err != nil {
		return nil, err
	}

	headers, err := c.buildHeaders(contentType, reqHeaders)
	if err != nil {
		return nil, err
	}

	options := map[string]any{
		"method":   method,
		"headers":  headers,
		"redirect": redirect,
	}

	if body != nil {
		options["body"] = c.encodeBody(body)
	}

	if c.cfg.Timeout > 0 || ctx.Done() != nil {
		signal, err := c.setupAbortSignal(ctx, reqCtx)
		if err != nil {
			return options, err
		}
		options["signal"] = signal
	}

	return options, nil
}

func methodAllowsBody(method string) bool {
	method = strings.ToUpper(method)
	return method != "GET" && method != "HEAD"
}

func (c *fetchHTTPClient) getRedirectMode() (string, error) {
	if !c.cfg.FollowRedirects.Enabled {
		return "", fmt.Errorf("disabling redirects is not supported in WebAssembly: Fetch manual mode hides redirect response metadata")
	}
	return "follow", nil
}

func (c *fetchHTTPClient) buildHeaders(contentType string, reqHeaders map[string][]string) (js.Value, error) {
	headers := js.Global().Get("Headers").New()

	for name, values := range reqHeaders {
		if len(values) == 0 {
			continue
		}
		if err := callHeadersMethod(headers, "set", name, values[0]); err != nil {
			return js.Undefined(), err
		}
		for _, value := range values[1:] {
			if err := callHeadersMethod(headers, "append", name, value); err != nil {
				return js.Undefined(), err
			}
		}
	}

	if contentType != "" {
		if err := callHeadersMethod(headers, "set", "Content-Type", contentType); err != nil {
			return js.Undefined(), err
		}
	}

	return headers, nil
}

func callHeadersMethod(headers js.Value, method, name, value string) (err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = fmt.Errorf("failed to %s header %q: %v", method, name, recovered)
		}
	}()

	headers.Call(method, name, value)
	return nil
}

func (c *fetchHTTPClient) encodeBody(body []byte) js.Value {
	uint8Array := js.Global().Get("Uint8Array").New(len(body))
	js.CopyBytesToJS(uint8Array, body)
	return uint8Array
}

func (c *fetchHTTPClient) setupAbortSignal(ctx context.Context, reqCtx *requestContext) (js.Value, error) {
	abortController := js.Global().Get("AbortController")
	if !abortController.Truthy() {
		return js.Undefined(), fmt.Errorf("AbortController API is not available")
	}

	controller := abortController.New()
	if !controller.Truthy() {
		return js.Undefined(), fmt.Errorf("failed to create AbortController")
	}

	if c.cfg.Timeout > 0 {
		reqCtx.timeout = time.AfterFunc(c.cfg.Timeout, func() {
			controller.Call("abort")
		})
	}
	if done := ctx.Done(); done != nil {
		go func() {
			select {
			case <-done:
				controller.Call("abort")
			case <-reqCtx.done:
			}
		}()
	}

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
	limit := c.cfg.ResponseLimits.MaxEntityBodySize
	stream := resp.Get("body")
	if !stream.Truthy() {
		return []byte{}, nil
	}

	reader := stream.Call("getReader")
	if limit >= 0 {
		contentLength := resp.Get("headers").Call("get", "Content-Length")
		if contentLength.Truthy() {
			length, err := strconv.ParseInt(contentLength.String(), 10, 64)
			if err == nil && length > limit {
				reader.Call("cancel")
				return nil, fmt.Errorf("response entity body size exceeds: %d bytes", limit)
			}
		}
	}

	var body bytes.Buffer
	var bodyLen int64
	for {
		chunk, err := awaitPromise(reader.Call("read"))
		if err != nil {
			return nil, fmt.Errorf("failed to read response body: %w", err)
		}
		if chunk.Get("done").Bool() {
			return body.Bytes(), nil
		}

		value := chunk.Get("value")
		chunkLen := int64(value.Get("byteLength").Int())
		if limit >= 0 && chunkLen > limit-bodyLen {
			reader.Call("cancel")
			return nil, fmt.Errorf("response entity body size exceeds: %d bytes", limit)
		}

		data := make([]byte, int(chunkLen))
		js.CopyBytesToGo(data, value)
		body.Write(data)
		bodyLen += chunkLen
	}
}
