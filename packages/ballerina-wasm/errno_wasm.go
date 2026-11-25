package main

import (
	"io/fs"
	"syscall"
	"syscall/js"
)

var errnoByCode = map[string]syscall.Errno{
	"EACCES":       syscall.EACCES,
	"EAGAIN":       syscall.EAGAIN,
	"EBADF":        syscall.EBADF,
	"EBUSY":        syscall.EBUSY,
	"EDQUOT":       syscall.EDQUOT,
	"EEXIST":       syscall.EEXIST,
	"EFBIG":        syscall.EFBIG,
	"EINTR":        syscall.EINTR,
	"EINVAL":       syscall.EINVAL,
	"EIO":          syscall.EIO,
	"EISDIR":       syscall.EISDIR,
	"ELOOP":        syscall.ELOOP,
	"EMFILE":       syscall.EMFILE,
	"EMLINK":       syscall.EMLINK,
	"ENAMETOOLONG": syscall.ENAMETOOLONG,
	"ENFILE":       syscall.ENFILE,
	"ENODEV":       syscall.ENODEV,
	"ENOENT":       syscall.ENOENT,
	"ENOMEM":       syscall.ENOMEM,
	"ENOSPC":       syscall.ENOSPC,
	"ENOSYS":       syscall.ENOSYS,
	"ENOTDIR":      syscall.ENOTDIR,
	"ENOTEMPTY":    syscall.ENOTEMPTY,
	"ENOTSUP":      syscall.ENOTSUP,
	"ENXIO":        syscall.ENXIO,
	"EPERM":        syscall.EPERM,
	"EPIPE":        syscall.EPIPE,
	"EROFS":        syscall.EROFS,
	"ESPIPE":       syscall.ESPIPE,
	"EXDEV":        syscall.EXDEV,
}

type hostFSError struct {
	message string
}

func (e *hostFSError) Error() string { return e.message }
func (e *hostFSError) Unwrap() error { return syscall.EIO }

func pathError(op, path string, err error) error {
	if jsErr, ok := err.(js.Error); ok {
		err = errorFromJS(jsErr.Value)
	}
	return &fs.PathError{Op: op, Path: path, Err: err}
}

func errorFromJS(value js.Value) error {
	if value.Type() == js.TypeObject {
		if code := value.Get("code"); code.Type() == js.TypeString {
			if errno, ok := errnoByCode[code.String()]; ok {
				return errno
			}
		}
		if message := value.Get("message"); message.Type() == js.TypeString && message.String() != "" {
			return &hostFSError{message: message.String()}
		}
		return syscall.EIO
	}
	if value.Type() == js.TypeString {
		return &hostFSError{message: value.String()}
	}
	return syscall.EIO
}
