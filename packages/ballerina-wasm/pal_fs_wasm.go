package main

import (
	"errors"
	"io/fs"
	"path"
	"sync"
)

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
