package main

import (
	_ "ballerina-lang-go/lib/rt"
	"ballerina-lang-go/projects"
	"ballerina-lang-go/projects/directory"
	"ballerina-lang-go/runtime"
	"fmt"
	"os"
	"syscall/js"
)

func main() {
	js.Global().Set("run", js.FuncOf(run))
	select {}
}

type runOptions struct {
	noColors bool
}

func parseRunOptions(opts js.Value) runOptions {
	if opts.IsUndefined() || opts.IsNull() {
		return runOptions{}
	}

	colors := opts.Get("colors")
	return runOptions{
		noColors: !colors.IsUndefined() && colors.Type() == js.TypeBoolean && !colors.Bool(),
	}
}

func run(this js.Value, args []js.Value) any {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "%v\n", r)
		}
	}()

	if len(args) < 2 {
		return jsError(fmt.Errorf("expected at least 2 arguments: (fsProxy, path)"))
	}

	proxy := args[0]
	path := args[1].String()

	var optsArg js.Value
	if len(args) >= 3 {
		optsArg = args[2]
	}
	opts := parseRunOptions(optsArg)

	fsys := NewBridgeFS(proxy)

	result, err := directory.LoadProject(fsys, path)
	if err != nil {
		return jsError(err)
	}

	if diags := result.Diagnostics(); diags.HasErrors() {
		printDiagnostics(fsys, path, os.Stderr, diags, opts.noColors)
		return nil
	}

	compilation := result.Project().CurrentPackage().Compilation()
	if diags := compilation.DiagnosticResult(); diags.HasErrors() {
		printDiagnostics(fsys, path, os.Stderr, diags, opts.noColors)
		return nil
	}

	birPkgs := projects.NewBallerinaBackend(compilation).BIRPackages()
	if len(birPkgs) == 0 {
		return jsError(fmt.Errorf("BIR generation failed: no BIR package produced"))
	}

	rt := runtime.NewRuntime()
	for _, birPkg := range birPkgs {
		if err := rt.Interpret(*birPkg); err != nil {
			return jsError(err)
		}
	}

	return nil
}

func jsError(err error) map[string]any {
	return map[string]any{"error": err.Error()}
}
