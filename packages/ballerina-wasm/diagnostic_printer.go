package main

import (
	"ballerina-lang-go/projects"
	"ballerina-lang-go/tools/diagnostics"
	"fmt"
	"io"
	"io/fs"
	"path"
	"strings"
)

type diagnosticLocation struct {
	filePath            string
	startLine, startCol int
	endLine, endCol     int
	numWidth            int
}

func buildDiagnosticLocation(filePath string, startLine, startCol, endLine, endCol int) diagnosticLocation {
	startLineNumStr := fmt.Sprintf("%d", startLine+1)
	endLineNumStr := fmt.Sprintf("%d", endLine+1)
	numWidth := len(startLineNumStr)
	if w := len(endLineNumStr); w > numWidth {
		numWidth = w
	}
	return diagnosticLocation{
		filePath:  filePath,
		startLine: startLine,
		startCol:  startCol,
		endLine:   endLine,
		endCol:    endCol,
		numWidth:  numWidth,
	}
}

func printDiagnostics(fsys fs.FS, path string, w io.Writer, diagResult projects.DiagnosticResult) {
	for _, d := range diagResult.Diagnostics() {
		printDiagnostic(fsys, path, w, d)
	}
}

func printDiagnostic(fsys fs.FS, path string, w io.Writer, d diagnostics.Diagnostic) {
	printDiagnosticHeader(w, d)

	location := d.Location()
	if location == nil {
		fmt.Fprintln(w)
		return
	}

	lineRange := location.LineRange()
	loc := buildDiagnosticLocation(
		lineRange.FileName(),
		lineRange.StartLine().Line(), lineRange.StartLine().Offset(),
		lineRange.EndLine().Line(), lineRange.EndLine().Offset(),
	)
	printDiagnosticLocation(w, loc)
	printSourceSnippet(w, loc, fsys, path)
	fmt.Fprintln(w)
}

func printDiagnosticHeader(w io.Writer, d diagnostics.Diagnostic) {
	info := d.DiagnosticInfo()
	codeStr := ""
	if c := info.Code(); c != "" {
		codeStr = fmt.Sprintf("[%s]", c)
	}
	fmt.Fprintf(w, "%s%s: %s\n",
		strings.ToLower(info.Severity().String()), codeStr, d.Message(),
	)
}

func printDiagnosticLocation(w io.Writer, loc diagnosticLocation) {
	fmt.Fprintf(w, "%*s--> %s:%d:%d\n",
		loc.numWidth, "", loc.filePath, loc.startLine+1, loc.startCol+1,
	)
	if loc.filePath != "" {
		fmt.Fprintf(w, "%*s |\n", loc.numWidth, "")
	}
}

func snippetSourcePath(fsys fs.FS, projectOrFilePath, diagFile string) string {
	if projectOrFilePath == "" {
		return diagFile
	}
	info, err := fs.Stat(fsys, projectOrFilePath)
	if err == nil && !info.IsDir() {
		return projectOrFilePath
	}
	return path.Join(projectOrFilePath, diagFile)
}

func printSourceSnippet(w io.Writer, loc diagnosticLocation, fsys fs.FS, path string) {
	content, err := fs.ReadFile(fsys, snippetSourcePath(fsys, path, loc.filePath))
	if err != nil {
		fmt.Fprintf(w, "%*s | Could not read source file: %v\n", loc.numWidth, "", err)
		return
	}
	lines := strings.Split(string(content), "\n")
	if loc.startLine >= len(lines) {
		return
	}

	for line := loc.startLine; line <= loc.endLine && line < len(lines); line++ {
		lineContent := strings.TrimSuffix(lines[line], "\r")
		lineNumStr := fmt.Sprintf("%d", line+1)

		startCol := 0
		var endCol int

		switch {
		case loc.startLine == loc.endLine:
			startCol = loc.startCol
			endCol = loc.endCol
		case line == loc.startLine:
			startCol = loc.startCol
			endCol = len(lineContent)
		case line == loc.endLine:
			startCol = 0
			endCol = loc.endCol
		default:
			startCol = 0
			endCol = len(lineContent)
		}

		var highlightLen int
		startCol, _, highlightLen = computeTrimmedCaretSpan(lineContent, startCol, endCol)

		fmt.Fprintf(w, "%*s | %s\n", loc.numWidth, lineNumStr, lineContent)
		pointer := buildPointer(lineContent, startCol, highlightLen)
		fmt.Fprintf(w, "%*s | %s\n", loc.numWidth, "", pointer)
	}
}

func computeTrimmedCaretSpan(lineContent string, startCol, endCol int) (trimStartCol, trimEndCol, highlightLen int) {
	firstNonWS := -1
	for i := 0; i < len(lineContent); i++ {
		if lineContent[i] != ' ' && lineContent[i] != '\t' {
			firstNonWS = i
			break
		}
	}
	lastNonWS := len(lineContent)
	hasNonWS := firstNonWS != -1
	if hasNonWS {
		for lastNonWS > firstNonWS && (lineContent[lastNonWS-1] == ' ' || lineContent[lastNonWS-1] == '\t') {
			lastNonWS--
		}
	}
	if !hasNonWS {
		return startCol, startCol, 0
	}
	if startCol < firstNonWS {
		startCol = firstNonWS
	}
	highlightLen = endCol - startCol
	return startCol, endCol, highlightLen
}

func buildPointer(lineContent string, startCol, highlightLen int) string {
	var b strings.Builder
	for i := 0; i < startCol && i < len(lineContent); i++ {
		if lineContent[i] == '\t' {
			b.WriteByte('\t')
		} else {
			b.WriteByte(' ')
		}
	}
	for range highlightLen {
		b.WriteByte('^')
	}
	return b.String()
}
