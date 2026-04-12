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

	noColors := false
	if len(args) >= 3 && !args[2].IsUndefined() {
		noColors = !args[2].Bool()
	}

	fsys := NewBridgeFS(proxy)

	result, err := directory.LoadProject(fsys, path)
	if err != nil {
		return jsError(err)
	}

	diags := result.Diagnostics()
	if diags.HasErrors() {
		printDiagnostics(fsys, path, os.Stderr, diags, noColors)
		return nil
	}

	project := result.Project()
	pkg := project.CurrentPackage()

	compilation := pkg.Compilation()
	diags = compilation.DiagnosticResult()
	if diags.HasErrors() {
		printDiagnostics(fsys, path, os.Stderr, diags, noColors)
		return nil
	}

	backend := projects.NewBallerinaBackend(compilation)
	birPkgs := backend.BIRPackages()

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
	return map[string]any{
		"error": err.Error(),
	}
}
