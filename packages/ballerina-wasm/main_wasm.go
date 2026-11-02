package main

import (
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"syscall/js"

	_ "github.com/ballerina-nutcracker/ballerina/lib/rt"
	"github.com/ballerina-nutcracker/ballerina/platform/pal"
	"github.com/ballerina-nutcracker/ballerina/projects"
	"github.com/ballerina-nutcracker/ballerina/runtime"
	"github.com/ballerina-nutcracker/ballerina/tools/diagnostics"
)

var (
	interpreterVersion  = "dev"
	interpreterRevision = "unknown"
)

func main() {
	js.Global().Set("run", js.FuncOf(run))
	js.Global().Set("stop", js.FuncOf(stop))
	js.Global().Set("version", js.FuncOf(version))

	js.Global().Set("dispatchHttpRequest", js.FuncOf(dispatchHTTPRequest))
	select {}
}

func version(_ js.Value, _ []js.Value) any {
	value := js.Global().Get("Object").New()
	value.Set("version", interpreterVersion)
	value.Set("revision", interpreterRevision)
	return value
}

func stop(_ js.Value, args []js.Value) any {
	if len(args) != 1 || args[0].Type() != js.TypeString {
		return false
	}

	switch args[0].String() {
	case "graceful":
		return activeRunContext.sendSignal(pal.GracefulStop)
	case "immediate":
		return activeRunContext.sendSignal(pal.ImmediateStop)
	default:
		return false
	}
}

type platformOptions struct {
	httpListenerTransport js.Value
	os                    js.Value
	net                   js.Value
}

type runOptions struct {
	noColors bool
	stdout   io.Writer
	stderr   io.Writer
	platform platformOptions
}

func parseRunOptions(opts js.Value) runOptions {
	if opts.IsUndefined() || opts.IsNull() {
		return runOptions{}
	}

	colors := opts.Get("colors")
	return runOptions{
		noColors: !colors.IsUndefined() && colors.Type() == js.TypeBoolean && !colors.Bool(),
		stdout:   streamWriterFromJS(opts.Get("stdout")),
		stderr:   streamWriterFromJS(opts.Get("stderr")),
		platform: parsePlatformOptions(opts.Get("platform")),
	}
}

func parsePlatformOptions(value js.Value) platformOptions {
	if value.Type() != js.TypeObject || value.IsNull() {
		return platformOptions{httpListenerTransport: js.Undefined(), os: js.Undefined(), net: js.Undefined()}
	}
	return platformOptions{
		httpListenerTransport: value.Get("httpListenerTransport"),
		os:                    value.Get("os"),
		net:                   value.Get("net"),
	}
}

func getWorkingDir(fsys fs.FS, p string) string {
	info, err := fs.Stat(fsys, p)
	if err == nil && info.IsDir() {
		return p
	}
	return path.Dir(p)
}

func run(_ js.Value, args []js.Value) any {
	return newPromise(func(resolve js.Value, _ js.Value) {
		resolve.Invoke(execute(args))
	})
}

// execute runs the program and releases everything it held before returning, so
// a run's promise only settles once its sockets are closed and its ports free.
func execute(args []js.Value) (exitCode int) {
	var optsArg js.Value
	if len(args) >= 3 {
		optsArg = args[2]
	}
	opts := parseRunOptions(optsArg)

	stdout, stderr := opts.stdout, opts.stderr
	if stdout == nil {
		stdout = os.Stdout
	}
	if stderr == nil {
		stderr = os.Stderr
	}

	if len(args) < 2 {
		fmt.Fprintln(stderr, "error: expected at least 2 arguments: (fsProxy, path)")
		return 1
	}

	proxy := args[0]
	runPath := args[1].String()

	signalSource, signals := newSignalSource()
	if !activeRunContext.begin(signalSource) {
		signalSource.cleanup()
		fmt.Fprintln(stderr, "error: a Ballerina run is already in progress")
		return 1
	}
	defer activeRunContext.end(signalSource)

	sockets := newSocketRegistry()
	defer sockets.closeAll()

	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(stderr, "error: %v\n", r)
			exitCode = 1
		}
	}()

	fsys := NewBridgeFS(proxy)

	result, err := projects.Load(fsys, runPath)
	if err != nil {
		fmt.Fprintf(stderr, "error: %v\n", err)
		return 1
	}

	if diags := result.Diagnostics(); diags.HasErrors() {
		printDiagnostics(fsys, runPath, stderr, diags, diagnostics.NewDiagnosticEnv(), opts.noColors)
		return 1
	}

	compilation := result.Project().CurrentPackage().Compilation()
	if diags := compilation.DiagnosticResult(); diags.HasErrors() {
		printDiagnostics(fsys, runPath, stderr, diags, compilation.DiagnosticEnv(), opts.noColors)
		return 1
	}

	birPkgs := projects.NewBallerinaBackend(compilation).BIRPackages()
	if len(birPkgs) == 0 {
		fmt.Fprintln(stderr, "error: BIR generation failed: no BIR package produced")
		return 1
	}

	cwd := getWorkingDir(fsys, runPath)
	pal := newPal(cwd, fsys, stdout, stderr, signals, opts.platform.httpListenerTransport, opts.platform.os, opts.platform.net, sockets)
	rt := runtime.NewRuntime(pal, result.Project().Environment().TypeEnv())
	if !activeRunContext.setRuntime(signalSource, rt) {
		fmt.Fprintln(stderr, "error: failed to register the Ballerina runtime")
		return 1
	}

	for _, birPkg := range birPkgs {
		if err := rt.Init(*birPkg); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
	}

	rt.Listen()
	return int(<-rt.ExitStatus)
}
