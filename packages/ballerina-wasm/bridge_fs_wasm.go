package main

import (
	"ballerina-lang-go/common/bfs"
	"bytes"
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
	return &bridgeFS{
		proxy: proxy,
	}
}

func (l *bridgeFS) Create(name string) (fs.File, error) {
	l.proxy.Call("writeFile", name, "")
	return l.Open(name)
}

func (l *bridgeFS) MkdirAll(path string, perm fs.FileMode) error {
	res := l.proxy.Call("mkdirAll", path)
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "mkdirAll", Path: path, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) Move(oldpath string, newpath string) error {
	res := l.proxy.Call("move", oldpath, newpath)
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "move", Path: oldpath, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) OpenFile(name string, _ int, _ fs.FileMode) (fs.File, error) {
	return l.Open(name)
}

func (l *bridgeFS) Remove(name string) error {
	res := l.proxy.Call("remove", name)
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "remove", Path: name, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) Open(name string) (fs.File, error) {
	result := l.proxy.Call("open", name)
	if result.IsNull() || result.IsUndefined() {
		stat := l.proxy.Call("stat", name)
		if !stat.IsNull() && !stat.IsUndefined() && stat.Get("isDir").Bool() {
			return l.openDir(name, stat)
		}
		return nil, &fs.PathError{Op: "open", Path: name, Err: fs.ErrNotExist}
	}

	if result.Get("isDir").Bool() {
		return l.openDir(name, result)
	}

	return &bridgeFileHandle{
		info: &bridgeFileInfo{
			name:    path.Base(name),
			size:    int64(result.Get("size").Int()),
			isDir:   false,
			modTime: time.Unix(int64(result.Get("modTime").Int()), 0),
		},
		reader: bytes.NewReader([]byte(result.Get("content").String())),
	}, nil
}

func (l *bridgeFS) openDir(name string, stat js.Value) (fs.File, error) {
	bridgeEntries := l.proxy.Call("readDir", name)
	if bridgeEntries.IsNull() || bridgeEntries.IsUndefined() {
		return nil, &fs.PathError{Op: "readDir", Path: name, Err: fs.ErrNotExist}
	}
	entries := make([]fs.DirEntry, bridgeEntries.Length())
	for i := 0; i < bridgeEntries.Length(); i++ {
		e := bridgeEntries.Index(i)
		entries[i] = &bridgeDirEntry{
			name:  e.Get("name").String(),
			isDir: e.Get("isDir").Bool(),
		}
	}

	return &bridgeDirHandle{
		info: &bridgeFileInfo{
			name:    path.Base(name),
			isDir:   true,
			modTime: time.Unix(int64(stat.Get("modTime").Int()), 0),
		},
		entries: entries,
	}, nil
}

func (l *bridgeFS) WriteFile(name string, data []byte, perm fs.FileMode) error {
	res := l.proxy.Call("writeFile", name, string(data))
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "writeFile", Path: name, Err: fs.ErrNotExist}
	}
	return nil
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
