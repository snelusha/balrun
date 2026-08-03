package main

import (
	"ballerina-lang-go/platform/pal"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"path"
	"strings"
	"sync"
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
	if limit := c.cfg.ResponseLimits.MaxEntityBodySize; limit >= 0 && int64(len(respBody)) > limit {
		return 0, nil, nil, fmt.Errorf("response entity body size exceeds: %d bytes", limit)
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
	options := map[string]any{
		"method":   method,
		"headers":  c.buildHeaders(contentType, reqHeaders),
		"redirect": c.getRedirectMode(),
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

type palFS struct {
	cwd  string
	fsys *bridgeFS
	mu   sync.Mutex
}

func (f *palFS) resolvePath(p string) string {
	if path.IsAbs(p) {
		return p
	}
	return path.Join(f.cwd, p)
}

func (f *palFS) createParentDirs(p string) error {
	dir := path.Dir(p)
	info, err := fs.Stat(f.fsys, dir)
	if err == nil {
		if !info.IsDir() {
			return &fs.PathError{Op: "mkdirAll", Path: dir, Err: fs.ErrInvalid}
		}
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return f.fsys.MkdirAll(dir, 0o755)
	}
	return err
}

func (f *palFS) readFile(p string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return fs.ReadFile(f.fsys, f.resolvePath(p))
}

func (f *palFS) writeFile(p string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	resolvedPath := f.resolvePath(p)
	if err := f.createParentDirs(resolvedPath); err != nil {
		return err
	}
	return f.fsys.WriteFile(resolvedPath, data, 0o644)
}

func (f *palFS) appendFile(p string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	resolvedPath := f.resolvePath(p)
	if err := f.createParentDirs(resolvedPath); err != nil {
		return err
	}
	current, err := fs.ReadFile(f.fsys, resolvedPath)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return f.fsys.WriteFile(resolvedPath, append(current, data...), 0o644)
}

func newPal(cwd string, fsys *bridgeFS, stdout, stderr io.Writer, signals pal.SignalSource) pal.Platform {
	palFS := &palFS{cwd: cwd, fsys: fsys}

	return pal.Platform{
		IO: pal.IO{
			Stdout: stdout.Write,
			Stderr: stderr.Write,
		},
		FS: pal.FS{
			ReadFile:   palFS.readFile,
			WriteFile:  palFS.writeFile,
			AppendFile: palFS.appendFile,
		},
		HTTP: pal.HTTP{
			NewClient: func(cfg pal.ClientConfig) pal.HTTPClient {
				return &fetchHTTPClient{cfg: cfg}
			},
		},
		Signals: signals,
	}
}
