package main

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/rand/v2"
	"os"
	"path"
	"strings"
	"syscall"

	"github.com/ballerina-nutcracker/ballerina/platform/pal"
)

const (
	defaultTempDir  = "/tmp"
	maxTempAttempts = 10_000
)

type palFS struct {
	cwd    string
	fsys   *bridgeFS
	getEnv func(name string) string
}

func newPalFS(cwd string, fsys *bridgeFS, getEnv func(name string) string) pal.FS {
	f := &palFS{cwd: cwd, fsys: fsys, getEnv: getEnv}
	return pal.FS{
		ReadFile:      f.readFile,
		WriteFile:     f.writeFile,
		AppendFile:    f.appendFile,
		OpenReadable:  f.openReadable,
		OpenWritable:  f.openWritable,
		Getwd:         f.getwd,
		Abs:           f.abs,
		Mkdir:         f.mkdir,
		MkdirAll:      f.mkdirAll,
		Remove:        f.remove,
		RemoveAll:     f.removeAll,
		Rename:        f.rename,
		CreateFile:    f.createFile,
		Stat:          f.stat,
		Lstat:         f.lstat,
		ReadDir:       f.readDir,
		Copy:          f.copy,
		CreateTemp:    f.createTemp,
		CreateTempDir: f.createTempDir,
		Readlink:      f.readlink,
		Watch:         f.watch,
	}
}

func (f *palFS) resolve(p string) string {
	if p == "" {
		return ""
	}
	if !path.IsAbs(p) {
		return path.Join(f.cwd, p)
	}
	p = path.Clean(p)
	if f.fsys.supportsAbsolutePaths() {
		return p
	}
	if p == "/" {
		return "."
	}
	return p[1:]
}

func (f *palFS) createParentDirs(resolved string) error {
	if resolved == "" {
		return nil
	}
	dir := path.Dir(resolved)
	info, err := f.fsys.Stat(dir)
	if err == nil {
		if !info.IsDir() {
			return pathError("mkdir", dir, syscall.ENOTDIR)
		}
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return f.fsys.MkdirAll(dir, 0o755)
	}
	return err
}

func (f *palFS) readFile(p string) ([]byte, error) {
	return f.fsys.ReadFile(f.resolve(p))
}

func (f *palFS) writeFile(p string, data []byte) error {
	resolved := f.resolve(p)
	if err := f.createParentDirs(resolved); err != nil {
		return err
	}
	return f.fsys.WriteFile(resolved, data, 0o644)
}

func (f *palFS) appendFile(p string, data []byte) error {
	resolved := f.resolve(p)
	if err := f.createParentDirs(resolved); err != nil {
		return err
	}
	return f.fsys.AppendFile(resolved, data)
}

func (f *palFS) openReadable(p string) (io.ReadCloser, error) {
	file, err := f.fsys.openFile(f.resolve(p), os.O_RDONLY)
	if err != nil {
		return nil, err
	}
	return file, nil
}

func (f *palFS) openWritable(p string, appendMode bool) (io.WriteCloser, error) {
	resolved := f.resolve(p)
	if err := f.createParentDirs(resolved); err != nil {
		return nil, err
	}
	flag := os.O_WRONLY | os.O_CREATE
	if appendMode {
		flag |= os.O_APPEND
	} else {
		flag |= os.O_TRUNC
	}
	file, err := f.fsys.openFile(resolved, flag)
	if err != nil {
		return nil, err
	}
	return file, nil
}

func (f *palFS) getwd() (string, error) {
	if path.IsAbs(f.cwd) {
		return path.Clean(f.cwd), nil
	}
	base, err := f.fsys.cwd()
	if err != nil {
		return "", err
	}
	return path.Join(base, f.cwd), nil
}

func (f *palFS) abs(p string) (string, error) {
	if !path.IsAbs(p) {
		cwd, err := f.getwd()
		if err != nil {
			return "", err
		}
		p = cwd + "/" + p
	}
	segments := strings.FieldsFunc(p, func(r rune) bool { return r == '/' })
	return "/" + strings.Join(segments, "/"), nil
}

func (f *palFS) mkdir(p string) error {
	return f.fsys.Mkdir(f.resolve(p))
}

func (f *palFS) mkdirAll(p string) error {
	return f.fsys.MkdirAll(f.resolve(p), 0o755)
}

func (f *palFS) remove(p string) error {
	return f.fsys.Remove(f.resolve(p))
}

func (f *palFS) removeAll(p string) error {
	return f.fsys.RemoveAll(f.resolve(p))
}

func (f *palFS) rename(oldPath, newPath string) error {
	from, to := f.resolve(oldPath), f.resolve(newPath)
	if _, err := f.fsys.Lstat(to); err == nil {
		if from == to {
			return nil
		}
		return pathError("rename", newPath, syscall.EEXIST)
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return f.fsys.Move(from, to)
}

func (f *palFS) createFile(p string) error {
	return f.createExclusive(f.resolve(p))
}

func (f *palFS) createExclusive(resolved string) error {
	file, err := f.fsys.openFile(resolved, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return err
	}
	return file.Close()
}

func (f *palFS) stat(p string) (*pal.FileInfo, error) {
	info, err := f.fsys.Stat(f.resolve(p))
	if err != nil {
		return nil, err
	}
	return f.fileInfo(p, info)
}

func (f *palFS) lstat(p string) (*pal.FileInfo, error) {
	info, err := f.fsys.Lstat(f.resolve(p))
	if err != nil {
		return nil, err
	}
	return f.fileInfo(p, info)
}

func (f *palFS) readDir(p string) ([]pal.FileInfo, error) {
	entries, err := f.fsys.ReadDir(f.resolve(p))
	if err != nil {
		return nil, err
	}
	infos := make([]pal.FileInfo, 0, len(entries))
	for _, entry := range entries {
		info, err := f.stat(path.Join(p, entry.Name()))
		if err != nil {
			return nil, err
		}
		info.IsSymlink = entry.Type()&fs.ModeSymlink != 0
		infos = append(infos, *info)
	}
	return infos, nil
}

func (f *palFS) fileInfo(p string, info fs.FileInfo) (*pal.FileInfo, error) {
	abs, err := f.abs(p)
	if err != nil {
		return nil, err
	}
	resolved := f.resolve(p)
	return &pal.FileInfo{
		AbsPath:    abs,
		Size:       info.Size(),
		ModifiedAt: info.ModTime(),
		IsDir:      info.IsDir(),
		IsSymlink:  info.Mode()&fs.ModeSymlink != 0,
		IsReadable: f.canAccess(resolved, info, "read"),
		IsWritable: f.canAccess(resolved, info, "write"),
	}, nil
}

func (f *palFS) canAccess(resolved string, info fs.FileInfo, access string) bool {
	if f.fsys.has("access") {
		_, err := f.fsys.call("access", resolved, "access", resolved, access)
		return err == nil
	}
	if access == "read" {
		return true
	}
	if info.IsDir() {
		return f.fsys.has("mkdir")
	}
	file, err := f.fsys.openFile(resolved, os.O_WRONLY)
	if err != nil {
		return false
	}
	return file.Close() == nil
}

func (f *palFS) copy(src, dst string, opts pal.CopyOptions) error {
	from, to := f.resolve(src), f.resolve(dst)
	// TODO: support CopyAttributes once Fs can change permissions and times.
	if opts.CopyAttributes {
		return pathError("copy", from, errors.ErrUnsupported)
	}
	info, err := f.fsys.Lstat(from)
	if err != nil {
		return err
	}
	if info.Mode()&fs.ModeSymlink != 0 {
		// TODO: support NoFollowLinks once Fs can create symbolic links.
		if opts.NoFollowLinks {
			return pathError("copy", from, errors.ErrUnsupported)
		}
		if info, err = f.fsys.Stat(from); err != nil {
			return err
		}
	}
	if info.IsDir() {
		// FIXME: Fs cannot resolve symbolic links, so a target inside the source
		// through a link is not detected.
		if from == "." || from == "/" || from == to || strings.HasPrefix(to, from+"/") {
			return pathError("copy", to, syscall.EINVAL)
		}
		return f.copyDir(from, to, opts)
	}
	return f.copyFile(from, to, opts)
}

func (f *palFS) copyDir(from, to string, opts pal.CopyOptions) error {
	if err := f.fsys.MkdirAll(to, 0o755); err != nil {
		return err
	}
	entries, err := f.fsys.ReadDir(from)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		src, dst := path.Join(from, entry.Name()), path.Join(to, entry.Name())
		isDir := entry.IsDir()
		if entry.Type()&fs.ModeSymlink != 0 {
			info, err := f.fsys.Stat(src)
			if err != nil {
				return err
			}
			// FIXME: Fs has no file identity to detect link loops with, so linked
			// directories inside a tree are refused instead of followed.
			if opts.NoFollowLinks || info.IsDir() {
				return pathError("copy", src, errors.ErrUnsupported)
			}
		}
		if isDir {
			err = f.copyDir(src, dst, opts)
		} else {
			err = f.copyFile(src, dst, opts)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// copyFile replaces an existing target instead of writing into it, so it never
// writes through a symbolic link. The source is opened first: its contents stay
// readable even if the target turns out to be the same file.
func (f *palFS) copyFile(from, to string, opts pal.CopyOptions) (err error) {
	if from == to {
		return nil
	}
	src, err := f.fsys.openFile(from, os.O_RDONLY)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()

	if _, err := f.fsys.Lstat(to); err == nil {
		if !opts.ReplaceExisting {
			return pathError("copy", to, syscall.EEXIST)
		}
		if err := f.fsys.Remove(to); err != nil {
			return err
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	dst, err := f.fsys.openFile(to, os.O_WRONLY|os.O_CREATE|os.O_EXCL)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := dst.Close(); err == nil {
			err = closeErr
		}
	}()
	_, err = io.CopyBuffer(dst, src, make([]byte, readBufferSize))
	return err
}

func (f *palFS) createTemp(prefix, suffix, dir string) (string, error) {
	return f.createTempEntry(prefix, suffix, dir, f.createExclusive)
}

func (f *palFS) createTempDir(prefix, suffix, dir string) (string, error) {
	return f.createTempEntry(prefix, suffix, dir, f.fsys.Mkdir)
}

func (f *palFS) createTempEntry(prefix, suffix, dir string, create func(resolved string) error) (string, error) {
	if strings.Contains(prefix, "/") || strings.Contains(suffix, "/") {
		return "", pathError("createtemp", prefix+"*"+suffix, errors.New("pattern contains path separator"))
	}
	if dir == "" {
		dir = f.getEnv("TMPDIR")
		if dir == "" {
			dir = defaultTempDir
		}
		if err := f.createParentDirs(path.Join(f.resolve(dir), "*")); err != nil {
			return "", err
		}
	}
	for range maxTempAttempts {
		name := path.Join(dir, fmt.Sprintf("%s%d%s", prefix, rand.Uint32(), suffix))
		abs, err := f.abs(name)
		if err != nil {
			return "", err
		}
		err = create(f.resolve(name))
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return "", err
		}
		return abs, nil
	}
	return "", pathError("createtemp", dir, syscall.EEXIST)
}

// TODO: support reading symbolic links once Fs has `readlink`.
func (f *palFS) readlink(p string) (string, error) {
	info, err := f.fsys.Lstat(f.resolve(p))
	if err != nil {
		return "", err
	}
	if info.Mode()&fs.ModeSymlink == 0 {
		return "", pathError("readlink", p, syscall.EINVAL)
	}
	return "", pathError("readlink", p, errors.ErrUnsupported)
}

// TODO: support watching once Fs has `watch`.
func (f *palFS) watch(p string, _ bool, _ pal.WatchHandler) (pal.WatchHandle, error) {
	return nil, pathError("watch", p, errors.ErrUnsupported)
}
