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

// run returns a JS Promise. All blocking work (including async FS calls that
// park on channels) runs inside a goroutine so the JS event loop stays free
// to fire the then/catch callbacks that callAsync depends on.
func run(this js.Value, args []js.Value) any {
	promiseConstructor := js.Global().Get("Promise")

	return promiseConstructor.New(js.FuncOf(func(_ js.Value, promArgs []js.Value) any {
		resolve := promArgs[0]
		reject := promArgs[1]

		go func() {
			result, err := doRun(args)
			if err != nil {
				reject.Invoke(jsError(err))
				return
			}
			if result != nil {
				resolve.Invoke(result)
			} else {
				resolve.Invoke(js.Undefined())
			}
		}()

		return nil
	}))
}

// doRun contains all the actual work, safe to call from a goroutine.
func doRun(args []js.Value) (any, error) {
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(os.Stderr, "%v\n", r)
		}
	}()

	if len(args) < 2 {
		return nil, fmt.Errorf("expected at least 2 arguments: (fsProxy, path)")
	}

	proxy := args[0]
	path := args[1].String()

	noColors := false
	if len(args) >= 3 && !args[2].IsUndefined() {
		noColors = !args[2].Bool()
	}

	fsys := NewBridgeFS(proxy)

	result, err := directory.LoadProject(fsys, path)
	if err != nil {
		return nil, err
	}

	diags := result.Diagnostics()
	if diags.HasErrors() {
		printDiagnostics(fsys, path, os.Stderr, diags, noColors)
		return nil, nil
	}

	project := result.Project()
	pkg := project.CurrentPackage()

	compilation := pkg.Compilation()
	diags = compilation.DiagnosticResult()
	if diags.HasErrors() {
		printDiagnostics(fsys, path, os.Stderr, diags, noColors)
		return nil, nil
	}

	backend := projects.NewBallerinaBackend(compilation)
	birPkgs := backend.BIRPackages()

	if len(birPkgs) == 0 {
		return nil, fmt.Errorf("BIR generation failed: no BIR package produced")
	}

	rt := runtime.NewRuntime()

	for _, birPkg := range birPkgs {
		if err := rt.Interpret(*birPkg); err != nil {
			return nil, err
		}
	}

	return nil, nil
}

func jsError(err error) map[string]any {
	return map[string]any{
		"error": err.Error(),
	}
}
