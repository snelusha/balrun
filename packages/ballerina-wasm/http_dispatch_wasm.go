package main

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall/js"
)

func dispatchHTTPRequest(_ js.Value, args []js.Value) any {
	return newPromise(func(resolve js.Value, reject js.Value) {
		if len(args) != 3 || args[0].Type() != js.TypeString || args[1].Type() != js.TypeNumber || args[2].Type() != js.TypeObject {
			reject.Invoke("dispatchHttpRequest: expected listener host, port, and request")
			return
		}
		host, port := args[0].String(), args[1].Int()
		handler, ok := activeRunContext.handler(host, port)
		if !ok {
			reject.Invoke(fmt.Sprintf("no service listening on %s", listenerKey(host, port)))
			return
		}
		req, err := httpRequestFromJS(args[2])
		if err != nil {
			reject.Invoke(err.Error())
			return
		}
		go func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					reject.Invoke(fmt.Sprint(recovered))
				}
			}()
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, req)
			response := recorder.Result()
			defer response.Body.Close()
			body, err := io.ReadAll(response.Body)
			if err != nil {
				reject.Invoke(err.Error())
				return
			}
			responseBody := js.Global().Get("Uint8Array").New(len(body))
			js.CopyBytesToJS(responseBody, body)
			resolve.Invoke(js.ValueOf(map[string]any{
				"statusCode": response.StatusCode,
				"headers":    headersToJS(response.Header),
				"body":       responseBody,
			}))
		}()
	})
}

func httpRequestFromJS(value js.Value) (*http.Request, error) {
	method := value.Get("method").String()
	if method == "" {
		method = http.MethodGet
	}
	requestPath := value.Get("path").String()
	if requestPath == "" {
		requestPath = "/"
	}
	if !strings.HasPrefix(requestPath, "/") {
		requestPath = "/" + requestPath
	}
	host := value.Get("host").String()
	if host == "" {
		host = "localhost"
	}
	bodyValue := value.Get("body")
	body := make([]byte, bodyValue.Get("byteLength").Int())
	js.CopyBytesToGo(body, bodyValue)
	req, err := http.NewRequest(method, "http://"+host+requestPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.RequestURI = requestPath
	req.Host = host
	req.ContentLength = int64(len(body))
	req.Header = headersFromJS(value.Get("headers"))
	return req, nil
}

func headersFromJS(value js.Value) http.Header {
	headers := make(http.Header)
	if value.Type() != js.TypeObject || value.IsNull() {
		return headers
	}
	keys := js.Global().Get("Object").Call("keys", value)
	for i := 0; i < keys.Length(); i++ {
		key := keys.Index(i).String()
		values := value.Get(key)
		for j := 0; j < values.Length(); j++ {
			headers.Add(key, values.Index(j).String())
		}
	}
	return headers
}

func headersToJS(headers http.Header) map[string]any {
	mapped := make(map[string]any, len(headers))
	for key, values := range headers {
		items := make([]any, len(values))
		for i, value := range values {
			items[i] = value
		}
		mapped[key] = items
	}
	return mapped
}
