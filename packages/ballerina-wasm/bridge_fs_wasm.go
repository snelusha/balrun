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
	"ballerina-lang-go/common/bfs"
	"bytes"
	"io"
	"io/fs"
	"path"
	"sync"
	"syscall/js"
	"time"
)

var (
	_ bfs.WritableFS = &bridgeFS{}
	_ bfs.MutableFS  = &bridgeFS{}
)

type bridgeFS struct {
	mu    sync.Mutex
	proxy js.Value
}

func NewBridgeFS(proxy js.Value) *bridgeFS {
	return &bridgeFS{
		proxy: proxy,
	}
}

func (l *bridgeFS) Create(name string) (fs.File, error) {
	res, err := l.bridgeCall("writeFile", name, name, "")
	if err != nil {
		return nil, err
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return nil, &fs.PathError{Op: "create", Path: name, Err: fs.ErrNotExist}
	}
	return l.Open(name)
}

func (l *bridgeFS) MkdirAll(path string, perm fs.FileMode) error {
	res, err := l.bridgeCall("mkdirAll", path, path)
	if err != nil {
		return err
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "mkdirAll", Path: path, Err: fs.ErrInvalid}
	}
	return nil
}

func (l *bridgeFS) Move(oldpath string, newpath string) error {
	res, err := l.bridgeCall("move", oldpath, oldpath, newpath)
	if err != nil {
		return err
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "move", Path: oldpath, Err: fs.ErrInvalid}
	}
	return nil
}

func (l *bridgeFS) OpenFile(name string, _ int, _ fs.FileMode) (fs.File, error) {
	return l.Open(name)
}

func (l *bridgeFS) Remove(name string) error {
	res, err := l.bridgeCall("remove", name, name)
	if err != nil {
		return err
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "remove", Path: name, Err: fs.ErrNotExist}
	}
	return nil
}

func (l *bridgeFS) Open(name string) (fs.File, error) {
	result, err := l.bridgeCall("open", name, name)
	if err != nil {
		return nil, err
	}
	if result.IsNull() || result.IsUndefined() {
		stat, err := l.bridgeCall("stat", name, name)
		if err != nil {
			return nil, err
		}
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
			modTime: time.UnixMilli(int64(result.Get("modTime").Float())),
		},
		reader: bytes.NewReader([]byte(result.Get("content").String())),
	}, nil
}

func (l *bridgeFS) openDir(name string, stat js.Value) (fs.File, error) {
	bridgeEntries, err := l.bridgeCall("readDir", name, name)
	if err != nil {
		return nil, err
	}
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
			modTime: time.UnixMilli(int64(stat.Get("modTime").Float())),
		},
		entries: entries,
	}, nil
}

func (l *bridgeFS) WriteFile(name string, data []byte, perm fs.FileMode) error {
	res, err := l.bridgeCall("writeFile", name, name, string(data))
	if err != nil {
		return err
	}
	if res.IsNull() || res.IsUndefined() || (res.Type() == js.TypeBoolean && !res.Bool()) {
		return &fs.PathError{Op: "writeFile", Path: name, Err: fs.ErrInvalid}
	}
	return nil
}

func (l *bridgeFS) bridgeCall(op string, path string, args ...any) (js.Value, error) {
	result, err := awaitPromise(l.proxy.Call(op, args...))
	if err != nil {
		return js.Null(), &fs.PathError{Op: op, Path: path, Err: err}
	}
	return result, nil
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
