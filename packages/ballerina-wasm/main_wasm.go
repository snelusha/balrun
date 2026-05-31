package main

import (
	_ "ballerina-lang-go/lib/rt"
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
	select {}
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
		if len(args) < 2 {
			resolve.Invoke(jsError(fmt.Errorf("expected at least 2 arguments: (fsProxy, path)")))
			return
		}

		proxy := args[0]
		path := args[1].String()

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

		defer func() {
			if r := recover(); r != nil {
				fmt.Fprintf(stderr, "%v\n", r)
				resolve.Invoke(js.Null())
			}
		}()

		fsys := NewBridgeFS(proxy)

		result, err := projects.Load(fsys, path)
		if err != nil {
			resolve.Invoke(jsError(err))
			return
		}

		if diags := result.Diagnostics(); diags.HasErrors() {
			printDiagnostics(fsys, path, stderr, diags, diagnostics.NewDiagnosticEnv(), opts.noColors)
			resolve.Invoke(js.Null())
			return
		}

		compilation := result.Project().CurrentPackage().Compilation()
		if diags := compilation.DiagnosticResult(); diags.HasErrors() {
			printDiagnostics(fsys, path, stderr, diags, compilation.DiagnosticEnv(), opts.noColors)
			resolve.Invoke(js.Null())
			return
		}

		birPkgs := projects.NewBallerinaBackend(compilation).BIRPackages()
		if len(birPkgs) == 0 {
			resolve.Invoke(jsError(fmt.Errorf("BIR generation failed: no BIR package produced")))
			return
		}

		pal := newPal(stdout, stderr)
		rt := runtime.NewRuntime(pal, result.Project().Environment().TypeEnv())
		for _, birPkg := range birPkgs {
			if err := rt.Interpret(*birPkg); err != nil {
				resolve.Invoke(jsError(err))
				return
			}
		}

		resolve.Invoke(js.Null())
	})
}

func jsError(err error) map[string]any {
	return map[string]any{"error": err.Error()}
}
