package main

import (
	"bufio"
	"errors"
	"io"
	"io/fs"
	"math"
	"os"
	"path"
	"slices"
	"strings"
	"sync"
	"syscall"
	"syscall/js"
	"time"

	"github.com/ballerina-nutcracker/ballerina/common/bfs"
)

const readBufferSize = 64 << 10

var (
	_ fs.StatFS      = (*bridgeFS)(nil)
	_ fs.ReadDirFS   = (*bridgeFS)(nil)
	_ fs.ReadFileFS  = (*bridgeFS)(nil)
	_ bfs.WritableFS = (*bridgeFS)(nil)
	_ bfs.MutableFS  = (*bridgeFS)(nil)

	_ io.ReadWriteCloser = (*bridgeFile)(nil)
	_ fs.ReadDirFile     = (*bridgeDir)(nil)
)

type bridgeFS struct {
	proxy js.Value

	mu     sync.Mutex
	open   map[*bridgeFile]struct{}
	closed bool
}

func newBridgeFS(proxy js.Value) *bridgeFS {
	return &bridgeFS{proxy: proxy, open: make(map[*bridgeFile]struct{})}
}

func (b *bridgeFS) has(method string) bool {
	return hasMethod(b.proxy, method)
}

func (b *bridgeFS) call(op, name, method string, args ...any) (js.Value, error) {
	if name == "" {
		return js.Undefined(), pathError(op, name, syscall.ENOENT)
	}
	if !b.has(method) {
		return js.Undefined(), pathError(op, name, syscall.EROFS)
	}
	res, err := callMethod(b.proxy, method, args...)
	if err != nil {
		return js.Undefined(), pathError(op, name, err)
	}
	return res, nil
}

func (b *bridgeFS) supportsAbsolutePaths() bool {
	return b.proxy.Get("supportsAbsolutePaths").Truthy()
}

func (b *bridgeFS) cwd() (string, error) {
	if !b.supportsAbsolutePaths() || !b.has("cwd") {
		return "/", nil
	}
	res, err := b.call("getwd", ".", "cwd")
	if err != nil {
		return "", err
	}
	if res.Type() != js.TypeString {
		return "", pathError("getwd", ".", syscall.EINVAL)
	}
	return res.String(), nil
}

func (b *bridgeFS) Stat(name string) (fs.FileInfo, error) {
	return b.stat("stat", name)
}

func (b *bridgeFS) Lstat(name string) (fs.FileInfo, error) {
	if !b.has("lstat") {
		return b.stat("stat", name)
	}
	return b.stat("lstat", name)
}

func (b *bridgeFS) stat(method, name string) (fs.FileInfo, error) {
	res, err := b.call(method, name, method, path.Clean(name))
	if err != nil {
		return nil, err
	}
	info, err := fileInfoFromJS(path.Base(name), res)
	if err != nil {
		return nil, pathError(method, name, err)
	}
	return info, nil
}

func (b *bridgeFS) ReadDir(name string) ([]fs.DirEntry, error) {
	res, err := b.call("readdir", name, "readdir", path.Clean(name))
	if err != nil {
		return nil, err
	}
	if !js.Global().Get("Array").Call("isArray", res).Bool() {
		return nil, pathError("readdir", name, syscall.EINVAL)
	}

	entries := make([]fs.DirEntry, res.Length())
	for i := range entries {
		entry := res.Index(i)
		if entry.Type() != js.TypeObject || entry.Get("name").Type() != js.TypeString {
			return nil, pathError("readdir", name, syscall.EINVAL)
		}
		mode, err := fileTypeFromJS(entry.Get("type"))
		if err != nil {
			return nil, pathError("readdir", name, err)
		}
		entries[i] = &bridgeDirEntry{
			fsys: b,
			dir:  name,
			name: entry.Get("name").String(),
			mode: mode,
		}
	}
	slices.SortFunc(entries, func(a, b fs.DirEntry) int {
		return strings.Compare(a.Name(), b.Name())
	})
	return entries, nil
}

func (b *bridgeFS) Open(name string) (fs.File, error) {
	file, err := b.openFile(name, os.O_RDONLY)
	if err == nil {
		return file, nil
	}
	if !errors.Is(err, syscall.EISDIR) {
		return nil, err
	}
	info, err := b.Stat(name)
	if err != nil {
		return nil, err
	}
	return &bridgeDir{fsys: b, name: name, info: info}, nil
}

func (b *bridgeFS) Create(name string) (fs.File, error) {
	return b.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_TRUNC, 0o666)
}

func (b *bridgeFS) OpenFile(name string, flag int, _ fs.FileMode) (fs.File, error) {
	file, err := b.openFile(name, flag)
	if err != nil {
		return nil, err
	}
	return file, nil
}

func (b *bridgeFS) openFile(name string, flag int) (*bridgeFile, error) {
	access := flag & (os.O_RDONLY | os.O_WRONLY | os.O_RDWR)
	write := access != os.O_RDONLY

	handle, err := b.call("open", name, "open", path.Clean(name), map[string]any{
		"read":      access != os.O_WRONLY,
		"write":     write,
		"create":    flag&os.O_CREATE != 0,
		"truncate":  flag&os.O_TRUNC != 0,
		"append":    flag&os.O_APPEND != 0,
		"exclusive": flag&os.O_EXCL != 0,
	})
	if err != nil {
		return nil, err
	}
	if handle.Type() != js.TypeObject || !hasMethod(handle, "read") {
		return nil, pathError("open", name, syscall.EINVAL)
	}

	file := &bridgeFile{fsys: b, name: name, handle: handle, writable: write}
	if write && !hasMethod(handle, "write") {
		_ = file.closeHandle()
		return nil, pathError("open", name, syscall.EACCES)
	}
	if !b.track(file) {
		_ = file.closeHandle()
		return nil, pathError("open", name, fs.ErrClosed)
	}
	return file, nil
}

func (b *bridgeFS) ReadFile(name string) ([]byte, error) {
	if !b.has("readFile") {
		file, err := b.openFile(name, os.O_RDONLY)
		if err != nil {
			return nil, err
		}
		defer func() { _ = file.Close() }()
		return io.ReadAll(bufio.NewReaderSize(file, readBufferSize))
	}

	res, err := b.call("read", name, "readFile", path.Clean(name))
	if err != nil {
		return nil, err
	}
	data, err := bytesFromJS(res)
	if err != nil {
		return nil, pathError("read", name, err)
	}
	return data, nil
}

func (b *bridgeFS) WriteFile(name string, data []byte, _ fs.FileMode) error {
	if b.has("writeFile") {
		_, err := b.call("write", name, "writeFile", path.Clean(name), bytesToJS(data))
		return err
	}
	return b.writeTo(name, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, data)
}

func (b *bridgeFS) AppendFile(name string, data []byte) error {
	return b.writeTo(name, os.O_WRONLY|os.O_CREATE|os.O_APPEND, data)
}

func (b *bridgeFS) writeTo(name string, flag int, data []byte) (err error) {
	file, err := b.openFile(name, flag)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := file.Close(); err == nil {
			err = closeErr
		}
	}()
	_, err = file.Write(data)
	return err
}

func (b *bridgeFS) Mkdir(name string) error {
	return b.mkdir(name, false)
}

func (b *bridgeFS) MkdirAll(name string, _ fs.FileMode) error {
	return b.mkdir(name, true)
}

func (b *bridgeFS) mkdir(name string, recursive bool) error {
	_, err := b.call("mkdir", name, "mkdir", path.Clean(name), map[string]any{"recursive": recursive})
	return err
}

func (b *bridgeFS) Remove(name string) error {
	return b.remove(name, false)
}

func (b *bridgeFS) RemoveAll(name string) error {
	err := b.remove(name, true)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (b *bridgeFS) remove(name string, recursive bool) error {
	_, err := b.call("remove", name, "rm", path.Clean(name), map[string]any{"recursive": recursive})
	return err
}

func (b *bridgeFS) Move(oldpath, newpath string) error {
	if newpath == "" {
		return pathError("rename", newpath, syscall.ENOENT)
	}
	_, err := b.call("rename", oldpath, "rename", path.Clean(oldpath), path.Clean(newpath))
	return err
}

// track reports false if the run ended while the file was being opened.
func (b *bridgeFS) track(file *bridgeFile) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return false
	}
	b.open[file] = struct{}{}
	return true
}

// closeAll waits only for files open for writing: closing them may be what saves
// them, while a pending read may never finish.
func (b *bridgeFS) closeAll() error {
	b.mu.Lock()
	b.closed = true
	files := b.open
	b.open = make(map[*bridgeFile]struct{})
	b.mu.Unlock()

	var errs []error
	for file := range files {
		if !file.writable {
			go func() { _ = file.Close() }()
			continue
		}
		if err := file.Close(); err != nil && !errors.Is(err, fs.ErrClosed) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

type bridgeFile struct {
	fsys     *bridgeFS
	name     string
	handle   js.Value
	writable bool

	mu     sync.Mutex
	offset int64
	closed bool
}

func (f *bridgeFile) Read(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return 0, pathError("read", f.name, fs.ErrClosed)
	}
	if len(p) == 0 {
		return 0, nil
	}

	res, err := callMethod(f.handle, "read", f.offset, len(p))
	if err != nil {
		return 0, pathError("read", f.name, err)
	}
	data, err := bytesFromJS(res)
	if err != nil {
		return 0, pathError("read", f.name, err)
	}
	if len(data) > len(p) {
		return 0, pathError("read", f.name, syscall.EIO)
	}
	if len(data) == 0 {
		return 0, io.EOF
	}
	f.offset += int64(len(data))
	return copy(p, data), nil
}

func (f *bridgeFile) Write(p []byte) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return 0, pathError("write", f.name, fs.ErrClosed)
	}
	if !hasMethod(f.handle, "write") {
		return 0, pathError("write", f.name, syscall.EBADF)
	}

	data := bytesToJS(p)
	written := 0
	for written < len(p) {
		res, err := callMethod(f.handle, "write", f.offset, data.Call("subarray", written))
		if err != nil {
			return written, pathError("write", f.name, err)
		}
		n, ok := intFromJS(res)
		if !ok || n <= 0 || n > int64(len(p)-written) {
			return written, pathError("write", f.name, syscall.EIO)
		}
		written += int(n)
		f.offset += n
	}
	return written, nil
}

func (f *bridgeFile) Stat() (fs.FileInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return nil, pathError("stat", f.name, fs.ErrClosed)
	}
	if !hasMethod(f.handle, "stat") {
		return f.fsys.Stat(f.name)
	}
	res, err := callMethod(f.handle, "stat")
	if err != nil {
		return nil, pathError("stat", f.name, err)
	}
	info, err := fileInfoFromJS(path.Base(f.name), res)
	if err != nil {
		return nil, pathError("stat", f.name, err)
	}
	return info, nil
}

func (f *bridgeFile) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.closed {
		return pathError("close", f.name, fs.ErrClosed)
	}
	f.closed = true

	// Untracked only once closed, so closeAll waits for a close in progress.
	defer func() {
		f.fsys.mu.Lock()
		delete(f.fsys.open, f)
		f.fsys.mu.Unlock()
	}()
	return f.closeHandle()
}

func (f *bridgeFile) closeHandle() error {
	if !hasMethod(f.handle, "close") {
		return nil
	}
	if _, err := callMethod(f.handle, "close"); err != nil {
		return pathError("close", f.name, err)
	}
	return nil
}

type bridgeDir struct {
	fsys    *bridgeFS
	name    string
	info    fs.FileInfo
	entries []fs.DirEntry
	listed  bool
}

func (d *bridgeDir) Close() error               { return nil }
func (d *bridgeDir) Stat() (fs.FileInfo, error) { return d.info, nil }

func (d *bridgeDir) Read([]byte) (int, error) {
	return 0, pathError("read", d.name, syscall.EISDIR)
}

func (d *bridgeDir) ReadDir(n int) ([]fs.DirEntry, error) {
	if !d.listed {
		entries, err := d.fsys.ReadDir(d.name)
		if err != nil {
			return nil, err
		}
		d.entries, d.listed = entries, true
	}
	if n <= 0 {
		n = len(d.entries)
	} else if len(d.entries) == 0 {
		return nil, io.EOF
	}
	n = min(n, len(d.entries))
	entries := d.entries[:n:n]
	d.entries = d.entries[n:]
	return entries, nil
}

type bridgeFileInfo struct {
	name    string
	size    int64
	mode    fs.FileMode
	modTime time.Time
}

func (i *bridgeFileInfo) Name() string       { return i.name }
func (i *bridgeFileInfo) Size() int64        { return i.size }
func (i *bridgeFileInfo) Mode() fs.FileMode  { return i.mode }
func (i *bridgeFileInfo) ModTime() time.Time { return i.modTime }
func (i *bridgeFileInfo) IsDir() bool        { return i.mode.IsDir() }
func (i *bridgeFileInfo) Sys() any           { return nil }

type bridgeDirEntry struct {
	fsys *bridgeFS
	dir  string
	name string
	mode fs.FileMode
}

func (e *bridgeDirEntry) Name() string      { return e.name }
func (e *bridgeDirEntry) IsDir() bool       { return e.mode.IsDir() }
func (e *bridgeDirEntry) Type() fs.FileMode { return e.mode }
func (e *bridgeDirEntry) Info() (fs.FileInfo, error) {
	return e.fsys.Lstat(path.Join(e.dir, e.name))
}

func fileTypeFromJS(value js.Value) (fs.FileMode, error) {
	if value.Type() == js.TypeString {
		switch value.String() {
		case "file":
			return 0, nil
		case "dir":
			return fs.ModeDir, nil
		case "symlink":
			return fs.ModeSymlink, nil
		}
	}
	return 0, syscall.EINVAL
}

func fileInfoFromJS(name string, value js.Value) (*bridgeFileInfo, error) {
	if value.Type() != js.TypeObject {
		return nil, syscall.EINVAL
	}
	mode, err := fileTypeFromJS(value.Get("type"))
	if err != nil {
		return nil, err
	}
	size, ok := intFromJS(value.Get("size"))
	if !ok {
		return nil, syscall.EINVAL
	}
	mtimeMs := value.Get("mtimeMs")
	if mtimeMs.Type() != js.TypeNumber {
		return nil, syscall.EINVAL
	}

	perm := fs.FileMode(0o644)
	if mode.IsDir() {
		perm = 0o755
	}
	if bits, ok := intFromJS(value.Get("mode")); ok {
		perm = fs.FileMode(bits) & fs.ModePerm
	}
	return &bridgeFileInfo{
		name:    name,
		size:    size,
		mode:    mode | perm,
		modTime: time.UnixMicro(int64(mtimeMs.Float() * 1000)),
	}, nil
}

func intFromJS(value js.Value) (int64, bool) {
	if value.Type() != js.TypeNumber {
		return 0, false
	}
	n := value.Float()
	if n != math.Trunc(n) || math.Abs(n) > 1<<53 {
		return 0, false
	}
	return int64(n), true
}
