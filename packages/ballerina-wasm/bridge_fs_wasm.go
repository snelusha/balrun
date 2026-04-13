package main

import (
	"ballerina-lang-go/common/bfs"
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"path"
	"syscall/js"
	"time"
)

var (
	_ bfs.WritableFS = &bridgeFS{}
	_ bfs.MutableFS  = &bridgeFS{}
)

type bridgeFS struct {
	proxy js.Value
}

func NewBridgeFS(proxy js.Value) *bridgeFS {
	return &bridgeFS{proxy: proxy}
}

// await blocks the GOROUTINE (not the JS thread) until the Promise resolves/rejects.
// IMPORTANT: Must always be called from inside a goroutine, never from the main JS thread directly.
// Uses buffered channels (size 1) to prevent goroutine leaks if the select exits early.
func await(awaitable js.Value) ([]js.Value, error) {
	then := make(chan []js.Value, 1)  // buffered — prevents callback from blocking
	catch := make(chan []js.Value, 1) // buffered — prevents callback from blocking

	thenFunc := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		then <- args
		return nil
	})
	defer thenFunc.Release()

	catchFunc := js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		catch <- args
		return nil
	})
	defer catchFunc.Release()

	awaitable.Call("then", thenFunc).Call("catch", catchFunc)

	select {
	case result := <-then:
		return result, nil
	case err := <-catch:
		if len(err) > 0 {
			return nil, fmt.Errorf("js error: %s", err[0].String())
		}
		return nil, fmt.Errorf("js promise rejected with no error")
	}
}

// awaitValue is a convenience wrapper that returns only the first resolved value.
func awaitValue(awaitable js.Value) (js.Value, error) {
	results, err := await(awaitable)
	if err != nil {
		return js.Undefined(), err
	}
	if len(results) == 0 {
		return js.Undefined(), nil
	}
	return results[0], nil
}

// callAsync calls a JS method and runs the callback in a NEW goroutine.
// Use this when calling bridgeFS methods from a JS-exposed function (js.FuncOf).
// The returned js.Func must be used as the JS-facing function.
//
// Example usage:
//
//	js.Global().Set("openFile", js.FuncOf(func(this js.Value, args []js.Value) interface{} {
//	    return bridgeFS.callAsync("open", args[0].String(), func(result js.Value, err error) {
//	        // handle result on JS side via a callback/promise
//	    })
//	}))
func callAsync(fn func() (js.Value, error), resolve func(js.Value), reject func(error)) {
	go func() {
		result, err := fn()
		if err != nil {
			reject(err)
			return
		}
		resolve(result)
	}()
}

// jsPromise wraps a Go async operation into a JS Promise.
// Use this when you need to return a Promise back to JavaScript.
func jsPromise(fn func() (js.Value, error)) js.Value {
	promiseConstructor := js.Global().Get("Promise")
	return promiseConstructor.New(js.FuncOf(func(this js.Value, args []js.Value) interface{} {
		resolve := args[0]
		reject := args[1]
		go func() {
			result, err := fn()
			if err != nil {
				// reject with a JS Error object
				errorConstructor := js.Global().Get("Error")
				reject.Invoke(errorConstructor.New(err.Error()))
				return
			}
			resolve.Invoke(result)
		}()
		return nil
	}))
}

// --- bridgeFS methods ---
// All proxy.Call() methods are assumed to return JS Promises.
// All methods must be called from within a goroutine to avoid deadlocking the JS thread.

func (l *bridgeFS) Create(name string) (fs.File, error) {
	_, err := awaitValue(l.proxy.Call("writeFile", name, ""))
	if err != nil {
		return nil, &fs.PathError{Op: "create", Path: name, Err: err}
	}
	return l.Open(name)
}

func (l *bridgeFS) MkdirAll(dirPath string, perm fs.FileMode) error {
	res, err := awaitValue(l.proxy.Call("mkdirAll", dirPath))
	if err != nil {
		return &fs.PathError{Op: "mkdirAll", Path: dirPath, Err: err}
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "mkdirAll", Path: dirPath, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) Move(oldpath string, newpath string) error {
	res, err := awaitValue(l.proxy.Call("move", oldpath, newpath))
	if err != nil {
		return &fs.PathError{Op: "move", Path: oldpath, Err: err}
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "move", Path: oldpath, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) OpenFile(name string, _ int, _ fs.FileMode) (fs.File, error) {
	return l.Open(name)
}

func (l *bridgeFS) Remove(name string) error {
	res, err := awaitValue(l.proxy.Call("remove", name))
	if err != nil {
		return &fs.PathError{Op: "remove", Path: name, Err: err}
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "remove", Path: name, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) Open(name string) (fs.File, error) {
	result, err := awaitValue(l.proxy.Call("open", name))
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}

	if result.IsNull() || result.IsUndefined() {
		// might be a directory — check with stat
		stat, err := awaitValue(l.proxy.Call("stat", name))
		if err != nil {
			return nil, &fs.PathError{Op: "open", Path: name, Err: err}
		}
		if !stat.IsNull() && !stat.IsUndefined() && stat.Get("isDir").Bool() {
			return l.openDir(name, stat)
		}
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}

	if result.Get("isDir").Bool() {
		return l.openDir(name, result)
	}

	return &localStorageFileHandle{
		info: &localStorageFileInfo{
			name:    path.Base(name),
			size:    int64(result.Get("size").Int()),
			isDir:   false,
			modTime: time.Unix(int64(result.Get("modTime").Int()), 0),
		},
		reader: bytes.NewReader([]byte(result.Get("content").String())),
	}, nil
}

func (l *bridgeFS) openDir(name string, stat js.Value) (fs.File, error) {
	entriesVal, err := awaitValue(l.proxy.Call("readDir", name))
	if err != nil {
		return nil, &fs.PathError{Op: "readDir", Path: name, Err: err}
	}
	if entriesVal.IsNull() || entriesVal.IsUndefined() {
		return nil, &fs.PathError{Op: "readDir", Path: name, Err: fs.ErrNotExist}
	}

	entries := make([]fs.DirEntry, entriesVal.Length())
	for i := 0; i < entriesVal.Length(); i++ {
		e := entriesVal.Index(i)
		entries[i] = &localStorageDirEntry{
			name:  e.Get("name").String(),
			isDir: e.Get("isDir").Bool(),
		}
	}

	return &localStorageDirHandle{
		info: &localStorageFileInfo{
			name:    path.Base(name),
			isDir:   true,
			modTime: time.Unix(int64(stat.Get("modTime").Int()), 0),
		},
		entries: entries,
	}, nil
}

func (l *bridgeFS) WriteFile(name string, data []byte, perm fs.FileMode) error {
	res, err := awaitValue(l.proxy.Call("writeFile", name, string(data)))
	if err != nil {
		return &fs.PathError{Op: "writeFile", Path: name, Err: err}
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "writeFile", Path: name, Err: fs.ErrNotExist}
	}
	return nil
}

// --- Exposing bridgeFS to JS safely ---
// Use these wrappers when setting functions on js.Global().
// Each one returns a JS Promise so the JS side can await them.

func (l *bridgeFS) JSOpen(name string) js.Value {
	return jsPromise(func() (js.Value, error) {
		file, err := l.Open(name)
		if err != nil {
			return js.Undefined(), err
		}
		// You can return a js object here with file details if needed
		_ = file
		return js.ValueOf(true), nil
	})
}

func (l *bridgeFS) JSWriteFile(name string, data string) js.Value {
	return jsPromise(func() (js.Value, error) {
		err := l.WriteFile(name, []byte(data), 0o644)
		if err != nil {
			return js.Undefined(), err
		}
		return js.ValueOf(true), nil
	})
}

// --- Unchanged handle/info/entry types ---

type (
	localStorageFileHandle struct {
		info   *localStorageFileInfo
		reader *bytes.Reader
	}
	localStorageDirHandle struct {
		info    *localStorageFileInfo
		entries []fs.DirEntry
		offset  int
	}
	localStorageFileInfo struct {
		name    string
		size    int64
		isDir   bool
		modTime time.Time
	}
	localStorageDirEntry struct {
		name  string
		isDir bool
	}
)

func (h *localStorageFileHandle) Close() error               { return nil }
func (h *localStorageFileHandle) Read(p []byte) (int, error) { return h.reader.Read(p) }
func (h *localStorageFileHandle) Stat() (fs.FileInfo, error) { return h.info, nil }

func (h *localStorageDirHandle) Close() error               { return nil }
func (h *localStorageDirHandle) Read([]byte) (int, error)   { return 0, io.EOF }
func (h *localStorageDirHandle) Stat() (fs.FileInfo, error) { return h.info, nil }
func (h *localStorageDirHandle) ReadDir(n int) ([]fs.DirEntry, error) {
	if n <= 0 {
		res := h.entries[h.offset:]
		h.offset = len(h.entries)
		return res, nil
	}
	if h.offset >= len(h.entries) {
		return nil, io.EOF
	}
	end := h.offset + n
	if end > len(h.entries) {
		end = len(h.entries)
	}
	res := h.entries[h.offset:end]
	h.offset = end
	return res, nil
}

func (i *localStorageFileInfo) Name() string { return i.name }
func (i *localStorageFileInfo) Size() int64  { return i.size }
func (i *localStorageFileInfo) Mode() fs.FileMode {
	if i.isDir {
		return fs.ModeDir | 0o755
	}
	return 0o644
}
func (i *localStorageFileInfo) ModTime() time.Time { return i.modTime }
func (i *localStorageFileInfo) IsDir() bool        { return i.isDir }
func (i *localStorageFileInfo) Sys() any           { return nil }

func (d *localStorageDirEntry) Name() string { return d.name }
func (d *localStorageDirEntry) IsDir() bool  { return d.isDir }
func (d *localStorageDirEntry) Type() fs.FileMode {
	if d.isDir {
		return fs.ModeDir
	}
	return 0
}

func (d *localStorageDirEntry) Info() (fs.FileInfo, error) {
	return &localStorageFileInfo{name: d.name, isDir: d.isDir}, nil
}
