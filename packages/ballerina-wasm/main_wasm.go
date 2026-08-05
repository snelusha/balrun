package main

import (
	_ "ballerina-lang-go/lib/rt"
	"ballerina-lang-go/platform/pal"
	"ballerina-lang-go/projects"
	"ballerina-lang-go/runtime"
	"ballerina-lang-go/tools/diagnostics"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"syscall/js"
)

func main() {
	js.Global().Set("run", js.FuncOf(run))
	js.Global().Set("stop", js.FuncOf(stop))

	js.Global().Set("dispatchHttpRequest", js.FuncOf(dispatchHTTPRequest))
	select {}
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
		return platformOptions{httpListenerTransport: js.Undefined()}
	}
	return platformOptions{httpListenerTransport: value.Get("httpListenerTransport")}
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
			resolve.Invoke(1)
			return
		}

		proxy := args[0]
		runPath := args[1].String()

		signalSource, signals := newSignalSource()
		if !activeRunContext.begin(signalSource) {
			signalSource.cleanup()
			fmt.Fprintln(stderr, "error: a Ballerina run is already in progress")
			resolve.Invoke(1)
			return
		}
		defer activeRunContext.end(signalSource)

		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintf(stderr, "error: %v\n", r)
				resolve.Invoke(1)
			}
		}()

		fsys := NewBridgeFS(proxy)

		result, err := projects.Load(fsys, runPath)
		if err != nil {
			fmt.Fprintf(stderr, "error: %v\n", err)
			resolve.Invoke(1)
			return
		}

		if diags := result.Diagnostics(); diags.HasErrors() {
			printDiagnostics(fsys, runPath, stderr, diags, diagnostics.NewDiagnosticEnv(), opts.noColors)
			resolve.Invoke(1)
			return
		}

		compilation := result.Project().CurrentPackage().Compilation()
		if diags := compilation.DiagnosticResult(); diags.HasErrors() {
			printDiagnostics(fsys, runPath, stderr, diags, compilation.DiagnosticEnv(), opts.noColors)
			resolve.Invoke(1)
			return
		}

		birPkgs := projects.NewBallerinaBackend(compilation).BIRPackages()
		if len(birPkgs) == 0 {
			fmt.Fprintln(stderr, "error: BIR generation failed: no BIR package produced")
			resolve.Invoke(1)
			return
		}

		cwd := getWorkingDir(fsys, runPath)
		pal := newPal(cwd, fsys, stdout, stderr, signals, opts.platform.httpListenerTransport)
		rt := runtime.NewRuntime(pal, result.Project().Environment().TypeEnv())
		if !activeRunContext.setRuntime(signalSource, rt) {
			fmt.Fprintln(stderr, "error: failed to register the Ballerina runtime")
			resolve.Invoke(1)
			return
		}

		for _, birPkg := range birPkgs {
			if err := rt.Init(*birPkg); err != nil {
				fmt.Fprintf(stderr, "error: %v\n", err)
				resolve.Invoke(1)
				return
			}
		}

		rt.Listen()
		exitCode := <-rt.ExitStatus
		resolve.Invoke(int(exitCode))
	})
}
