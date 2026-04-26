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

var OperationFailedError = errors.New("operation failed")

type bridgeFS struct {
	proxy js.Value
}

func NewBridgeFS(proxy js.Value) *bridgeFS {
	return &bridgeFS{
		proxy: proxy,
	}
}

func isFalsy(v js.Value) bool {
	return v.IsNull() || v.IsUndefined() || (v.Type() == js.TypeBoolean && !v.Bool())
}

func pathError(op, path string, err error) error {
	return &fs.PathError{Op: op, Path: path, Err: err}
}

func (l *bridgeFS) Create(name string) (fs.File, error) {
	res, err := l.bridgeCall("create", name, "writeFile", name, "")
	if err != nil {
		return nil, err
	}
	if isFalsy(res) {
		return nil, pathError("create", name, OperationFailedError)
	}
	return l.Open(name)
}

func (l *bridgeFS) MkdirAll(dirPath string, perm fs.FileMode) error {
	res, err := l.bridgeCall("mkdirAll", dirPath, "mkdirAll", dirPath)
	if err != nil {
		return err
	}
	if isFalsy(res) {
		return pathError("mkdirAll", dirPath, OperationFailedError)
	}
	return nil
}

func (l *bridgeFS) Move(oldpath string, newpath string) error {
	res, err := l.bridgeCall("move", oldpath, "move", oldpath, newpath)
	if err != nil {
		return err
	}
	if isFalsy(res) {
		return pathError("move", oldpath, OperationFailedError)
	}
	return nil
}

func (l *bridgeFS) OpenFile(name string, _ int, _ fs.FileMode) (fs.File, error) {
	return l.Open(name)
}

func (l *bridgeFS) Remove(name string) error {
	res, err := l.bridgeCall("remove", name, "remove", name)
	if err != nil {
		return err
	}
	if isFalsy(res) {
		return pathError("remove", name, OperationFailedError)
	}
	return nil
}

func (l *bridgeFS) Open(name string) (fs.File, error) {
	res, err := l.bridgeCall("open", name, "open", name)
	if err != nil {
		return nil, err
	}

	if isFalsy(res) {
		stat, statErr := l.bridgeCall("stat", name, "stat", name)
		if statErr != nil {
			return nil, statErr
		}
		if !isFalsy(stat) && stat.Get("isDir").Bool() {
			return l.openDir(name, stat)
		}
		return nil, pathError("open", name, fs.ErrNotExist)
	}

	if res.Get("isDir").Bool() {
		return l.openDir(name, res)
	}

	return &bridgeFileHandle{
		info: &bridgeFileInfo{
			name:    path.Base(name),
			size:    int64(res.Get("size").Int()),
			isDir:   false,
			modTime: time.UnixMilli(int64(res.Get("modTime").Float())),
		},
		reader: bytes.NewReader([]byte(res.Get("content").String())),
	}, nil
}

func (l *bridgeFS) openDir(name string, stat js.Value) (fs.File, error) {
	raw, err := l.bridgeCall("readDir", name, "readDir", name)
	if err != nil {
		return nil, err
	}
	if isFalsy(raw) {
		return nil, pathError("readDir", name, fs.ErrNotExist)
	}

	entries := make([]fs.DirEntry, raw.Length())
	for i := range entries {
		e := raw.Index(i)
		entries[i] = &bridgeDirEntry{
			name:  e.Get("name").String(),
			isDir: e.Get("isDir").Bool(),
		}
	}

	return &bridgeDirHandle{
		info: &bridgeFileInfo{
			name:    path.Base(name),
			isDir:   true,
			modTime: time.UnixMilli(int64(stat.Get("modTime").Float())),
		},
		entries: entries,
	}, nil
}

func (l *bridgeFS) WriteFile(name string, data []byte, perm fs.FileMode) error {
	res, err := l.bridgeCall("writeFile", name, "writeFile", name, string(data))
	if err != nil {
		return err
	}
	if isFalsy(res) {
		return pathError("writeFile", name, OperationFailedError)
	}
	return nil
}

func (l *bridgeFS) bridgeCall(op, path string, method string, args ...any) (js.Value, error) {
	res, err := awaitPromise(l.proxy.Call(method, args...))
	if err != nil {
		return js.Undefined(), &fs.PathError{Op: op, Path: path, Err: err}
	}
	return res, nil
}

type (
	bridgeFileHandle struct {
		info   *bridgeFileInfo
		reader *bytes.Reader
	}
	bridgeDirHandle struct {
		info    *bridgeFileInfo
		entries []fs.DirEntry
		offset  int
	}
	bridgeFileInfo struct {
		name    string
		size    int64
		isDir   bool
		modTime time.Time
	}
	bridgeDirEntry struct {
		name  string
		isDir bool
	}
)

func (h *bridgeFileHandle) Close() error               { return nil }
func (h *bridgeFileHandle) Read(p []byte) (int, error) { return h.reader.Read(p) }
func (h *bridgeFileHandle) Stat() (fs.FileInfo, error) { return h.info, nil }

func (h *bridgeDirHandle) Close() error               { return nil }
func (h *bridgeDirHandle) Read([]byte) (int, error)   { return 0, io.EOF }
func (h *bridgeDirHandle) Stat() (fs.FileInfo, error) { return h.info, nil }
func (h *bridgeDirHandle) ReadDir(n int) ([]fs.DirEntry, error) {
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

func (i *bridgeFileInfo) Name() string { return i.name }
func (i *bridgeFileInfo) Size() int64  { return i.size }
func (i *bridgeFileInfo) Mode() fs.FileMode {
	if i.isDir {
		return fs.ModeDir | 0o755
	}
	return 0o644
}
func (i *bridgeFileInfo) ModTime() time.Time { return i.modTime }
func (i *bridgeFileInfo) IsDir() bool        { return i.isDir }
func (i *bridgeFileInfo) Sys() any           { return nil }

func (d *bridgeDirEntry) Name() string { return d.name }
func (d *bridgeDirEntry) IsDir() bool  { return d.isDir }
func (d *bridgeDirEntry) Type() fs.FileMode {
	if d.isDir {
		return fs.ModeDir
	}
	return 0
}

func (d *bridgeDirEntry) Info() (fs.FileInfo, error) {
	return &bridgeFileInfo{name: d.name, isDir: d.isDir}, nil
}
