package main

import (
	_ "ballerina-lang-go/lib/rt"
	"ballerina-lang-go/platform/pal"
	"ballerina-lang-go/projects"
	"ballerina-lang-go/runtime"
	"ballerina-lang-go/tools/diagnostics"
	"fmt"
	"io"
	"os"
	"syscall/js"
)

func main() {
	js.Global().Set("run", js.FuncOf(run))
	js.Global().Set("stop", js.FuncOf(stop))
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

type runOptions struct {
	noColors bool
	stdout   io.Writer
	stderr   io.Writer
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
	}
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
		path := args[1].String()

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

		result, err := projects.Load(fsys, path)
		if err != nil {
			fmt.Fprintf(stderr, "error: %v\n", err)
			resolve.Invoke(1)
			return
		}

		if diags := result.Diagnostics(); diags.HasErrors() {
			printDiagnostics(fsys, path, stderr, diags, diagnostics.NewDiagnosticEnv(), opts.noColors)
			resolve.Invoke(1)
			return
		}

		compilation := result.Project().CurrentPackage().Compilation()
		if diags := compilation.DiagnosticResult(); diags.HasErrors() {
			printDiagnostics(fsys, path, stderr, diags, compilation.DiagnosticEnv(), opts.noColors)
			resolve.Invoke(1)
			return
		}

		birPkgs := projects.NewBallerinaBackend(compilation).BIRPackages()
		if len(birPkgs) == 0 {
			fmt.Fprintln(stderr, "error: BIR generation failed: no BIR package produced")
			resolve.Invoke(1)
			return
		}

		pal := newPal(stdout, stderr, signals)
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
