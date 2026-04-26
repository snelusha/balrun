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
		go func() {
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
			if stderr == nil {
				stderr = os.Stderr
			}

			defer func() {
				if r := recover(); r != nil {
					fmt.Fprintf(stderr, "%v\n", r)
				}
			}()

			fsys := NewBridgeFS(proxy)

			result, err := directory.LoadProject(fsys, path)
			if err != nil {
				resolve.Invoke(jsError(err))
				return
			}

			if diags := result.Diagnostics(); diags.HasErrors() {
				printDiagnostics(fsys, path, stderr, diags, opts.noColors)
				resolve.Invoke(js.Null())
				return
			}

			compilation := result.Project().CurrentPackage().Compilation()
			if diags := compilation.DiagnosticResult(); diags.HasErrors() {
				printDiagnostics(fsys, path, stderr, diags, opts.noColors)
				resolve.Invoke(js.Null())
				return
			}

			birPkgs := projects.NewBallerinaBackend(compilation).BIRPackages()
			if len(birPkgs) == 0 {
				resolve.Invoke(jsError(fmt.Errorf("BIR generation failed: no BIR package produced")))
				return
			}

			rt := runtime.NewRuntime()
			if stdout != nil {
				runtime.RegisterExternFunction(rt, "ballerina", "io", "println", capturePrintlnOutput(opts.stdout))
			}
			for _, birPkg := range birPkgs {
				if err := rt.Interpret(*birPkg); err != nil {
					resolve.Invoke(jsError(err))
					return
				}
			}

			resolve.Invoke(js.Null())
		}()
	})
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
	return map[string]any{"error": err.Error()}
}
