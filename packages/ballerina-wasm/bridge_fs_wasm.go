package main

import (
	"ballerina-lang-go/common/bfs"
	"bytes"
	"errors"
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

// jsResult holds the settled value of a JS Promise.
type jsResult struct {
	value js.Value
	err   error
}

// callAsync calls a method on a JS proxy and awaits the returned Promise.
// The method must return a Promise; the resolved value is returned as js.Value.
// If the Promise rejects, the error string from JS is wrapped in a Go error.
func callAsync(proxy js.Value, method string, args ...any) (js.Value, error) {
	promise := proxy.Call(method, args...)

	ch := make(chan jsResult, 1)

	thenFunc := js.FuncOf(func(_ js.Value, thenArgs []js.Value) any {
		val := js.Undefined()
		if len(thenArgs) > 0 {
			val = thenArgs[0]
		}
		ch <- jsResult{value: val}
		return nil
	})
	catchFunc := js.FuncOf(func(_ js.Value, catchArgs []js.Value) any {
		msg := "unknown JS error"
		if len(catchArgs) > 0 {
			msg = catchArgs[0].String()
		}
		ch <- jsResult{err: errors.New(msg)}
		return nil
	})

	promise.Call("then", thenFunc).Call("catch", catchFunc)

	res := <-ch

	thenFunc.Release()
	catchFunc.Release()

	return res.value, res.err
}

// isFalsy returns true when a JS value is null, undefined, or boolean false —
// i.e. the conventional "failure" sentinel used by the proxy methods.
func isFalsy(v js.Value) bool {
	return v.IsNull() || v.IsUndefined() || (v.Type() == js.TypeBoolean && !v.Bool())
}

// ─── bridgeFS ────────────────────────────────────────────────────────────────

type bridgeFS struct {
	proxy js.Value
}

func NewBridgeFS(proxy js.Value) *bridgeFS {
	return &bridgeFS{proxy: proxy}
}

func (l *bridgeFS) Create(name string) (fs.File, error) {
	if _, err := callAsync(l.proxy, "writeFile", name, ""); err != nil {
		return nil, &fs.PathError{Op: "create", Path: name, Err: err}
	}
	return l.Open(name)
}

func (l *bridgeFS) MkdirAll(dirPath string, _ fs.FileMode) error {
	res, err := callAsync(l.proxy, "mkdirAll", dirPath)
	if err != nil {
		return &fs.PathError{Op: "mkdirAll", Path: dirPath, Err: err}
	}
	if isFalsy(res) {
		return &fs.PathError{Op: "mkdirAll", Path: dirPath, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) Move(oldpath, newpath string) error {
	res, err := callAsync(l.proxy, "move", oldpath, newpath)
	if err != nil {
		return &fs.PathError{Op: "move", Path: oldpath, Err: err}
	}
	if isFalsy(res) {
		return &fs.PathError{Op: "move", Path: oldpath, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) OpenFile(name string, _ int, _ fs.FileMode) (fs.File, error) {
	return l.Open(name)
}

func (l *bridgeFS) Remove(name string) error {
	res, err := callAsync(l.proxy, "remove", name)
	if err != nil {
		return &fs.PathError{Op: "remove", Path: name, Err: err}
	}
	if isFalsy(res) {
		return &fs.PathError{Op: "remove", Path: name, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) Open(name string) (fs.File, error) {
	result, err := callAsync(l.proxy, "open", name)
	if err != nil {
		return nil, &fs.PathError{Op: "open", Path: name, Err: err}
	}

	if isFalsy(result) {
		// Might still be a directory — fall back to stat.
		stat, statErr := callAsync(l.proxy, "stat", name)
		if statErr == nil && !isFalsy(stat) && stat.Get("isDir").Bool() {
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
	raw, err := callAsync(l.proxy, "readDir", name)
	if err != nil {
		return nil, &fs.PathError{Op: "readDir", Path: name, Err: err}
	}
	if isFalsy(raw) {
		return nil, &fs.PathError{Op: "readDir", Path: name, Err: fs.ErrNotExist}
	}

	entries := make([]fs.DirEntry, raw.Length())
	for i := range entries {
		e := raw.Index(i)
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

func (l *bridgeFS) WriteFile(name string, data []byte, _ fs.FileMode) error {
	res, err := callAsync(l.proxy, "writeFile", name, string(data))
	if err != nil {
		return &fs.PathError{Op: "writeFile", Path: name, Err: err}
	}
	if isFalsy(res) {
		return &fs.PathError{Op: "writeFile", Path: name, Err: fs.ErrNotExist}
	}
	return nil
}

// ─── handle / info / entry types ─────────────────────────────────────────────

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
	end := min(h.offset+n, len(h.entries))
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

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
