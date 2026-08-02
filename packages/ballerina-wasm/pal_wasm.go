package main

import (
	"ballerina-lang-go/platform/pal"
	"errors"
	"io"
	"io/fs"
	"maps"
	"path"
	"sync"
	"time"
)

var processStart = time.Now()

func resolvePath(cwd string, p string) string {
	if path.IsAbs(p) {
		return p
	}
	return path.Join(cwd, p)
}

type environment struct {
	mu     sync.RWMutex
	values map[string]string
}

func newEnvironment() *environment {
	return &environment{values: make(map[string]string)}
}

func (e *environment) get(key string) string {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.values[key]
}

func (e *environment) set(key, value string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.values[key] = value
	return nil
}

func (e *environment) unset(key string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	delete(e.values, key)
	return nil
}

func (e *environment) list() map[string]string {
	e.mu.RLock()
	defer e.mu.RUnlock()

	values := make(map[string]string, len(e.values))
	maps.Copy(values, e.values)
	return values
}

func createParentDirs(fsys *bridgeFS, p string) error {
	dir := path.Dir(p)
	info, err := fs.Stat(fsys, dir)
	if err == nil {
		if !info.IsDir() {
			return &fs.PathError{Op: "mkdirAll", Path: dir, Err: fs.ErrInvalid}
		}
		return nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return fsys.MkdirAll(dir, 0o755)
	}
	return err
}

func wasmPal(fsys *bridgeFS, cwd string, stderr, stdout io.Writer, signals pal.SignalSource) pal.Platform {
	env := newEnvironment()

	return pal.Platform{
		IO: pal.IO{
			Stdout: stdout.Write,
			Stderr: stderr.Write,
		},
		FS: pal.FS{
			ReadFile: func(p string) ([]byte, error) {
				return fs.ReadFile(fsys, resolvePath(cwd, p))
			},
			WriteFile: func(p string, data []byte) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolvedPath := resolvePath(cwd, p)
				if err := createParentDirs(fsys, resolvedPath); err != nil {
					return err
				}
				return fsys.WriteFile(resolvedPath, data, 0o644)
			},
			AppendFile: func(p string, data []byte) error {
				fsys.mu.Lock()
				defer fsys.mu.Unlock()

				resolved := resolvePath(cwd, p)
				if err := createParentDirs(fsys, resolved); err != nil {
					return err
				}
				current, err := fs.ReadFile(fsys, resolved)
				if err != nil && !errors.Is(err, fs.ErrNotExist) {
					return err
				}
				return fsys.WriteFile(resolved, append(current, data...), 0o644)
			},
		},
		OS: pal.OS{
			GetEnv: env.get,
			GetUsername: func() string {
				panic("GetUsername is not supported in Playground")
			},
			GetUserHome: func() string {
				panic("GetUserHome is not supported in Playground")
			},
			SetEnv:   env.set,
			UnsetEnv: env.unset,
			ListEnv:  env.list,
			Exec: func(command string, args []string, envOverride map[string]string) (pal.ProcessHandle, error) {
				panic("Exec is not supported in Playground")
			},
		},
		Time: pal.Time{
			Now:          time.Now,
			MonotonicNow: func() time.Duration { return time.Since(processStart) },
		},
		HTTP: pal.HTTP{
			NewClient: func(cfg pal.ClientConfig) pal.HTTPClient {
				return &fetchHTTPClient{cfg: cfg}
			},
			Listen: listen,
		},
		Signals: signals,
	}
}
