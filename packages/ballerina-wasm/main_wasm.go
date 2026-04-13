package main

import (
	_ "ballerina-lang-go/lib/rt"
	"ballerina-lang-go/projects"
	"ballerina-lang-go/projects/directory"
	"ballerina-lang-go/runtime"
	"ballerina-lang-go/values"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall/js"
)

func main() {
	js.Global().Set("run", js.FuncOf(run))

	select {}
}

func run(this js.Value, args []js.Value) any {
	var stderrWriter io.Writer = os.Stderr
	defer func() {
		if r := recover(); r != nil {
			fmt.Fprintf(stderrWriter, "%v\n", r)
		}
	}()

	if len(args) < 2 {
		return jsError(fmt.Errorf("expected at least 2 arguments: (fsProxy, path)"))
	}

	proxy := args[0]
	path := args[1].String()

	opts := js.Undefined()
	if len(args) >= 3 {
		opts = args[2]
	}
	stdoutWriter, stderrWriter, noColors := parseRunWriters(opts)

	fsys := NewBridgeFS(proxy)

	result, err := directory.LoadProject(fsys, path)
	if err != nil {
		return jsError(err)
	}

	diags := result.Diagnostics()
	if diags.HasErrors() {
		printDiagnostics(fsys, path, stderrWriter, diags, noColors)
		return nil
	}

	project := result.Project()
	pkg := project.CurrentPackage()

	compilation := pkg.Compilation()
	diags = compilation.DiagnosticResult()
	if diags.HasErrors() {
		printDiagnostics(fsys, path, stderrWriter, diags, noColors)
		return nil
	}

	backend := projects.NewBallerinaBackend(compilation)
	birPkgs := backend.BIRPackages()

	if len(birPkgs) == 0 {
		return jsError(fmt.Errorf("BIR generation failed: no BIR package produced"))
	}

	rt := runtime.NewRuntime()
	runtime.RegisterExternFunction(rt, "ballerina", "io", "println", capturePrintlnOutput(stdoutWriter))
	for _, birPkg := range birPkgs {
		if err := rt.Interpret(*birPkg); err != nil {
			return jsError(err)
		}
	}

	return nil
}

func capturePrintlnOutput(w io.Writer) func(args []values.BalValue) (values.BalValue, error) {
	return func(args []values.BalValue) (values.BalValue, error) {
		var b strings.Builder
		visited := make(map[uintptr]bool)
		for _, arg := range args {
			b.WriteString(values.String(arg, visited))
		}
		b.WriteByte('\n')
		_, err := io.WriteString(w, b.String())

		return nil, err
	}
}

func jsError(err error) map[string]any {
	return map[string]any{
		"error": err.Error(),
	}
}
