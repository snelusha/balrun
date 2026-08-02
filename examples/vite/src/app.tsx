import { useMemo, useRef, useState } from "react";

import { BallerinaProvider, useBallerina } from "@snelusha/balrun/react";

import type { DirEntry, FS, OpenResult, StatResult } from "@snelusha/balrun";

const DEFAULT_CODE = `import ballerina/io;

public function main() {
    io:println("Hello from Ballerina!");
}`;

export default function App() {
	const [code, setCode] = useState(DEFAULT_CODE);
	const [output, setOutput] = useState("no output");

	const codeRef = useRef(DEFAULT_CODE);

	const updateCode = (value: string) => {
		codeRef.current = value;
		setCode(value);
	};

	const fs = useMemo(
		() =>
			({
				open: async (path): Promise<OpenResult | null> => {
					if (path === "main.bal") {
						const content = codeRef.current;
						return { content, size: content.length, modTime: 0, isDir: false };
					}
					return null;
				},
				stat: async (path): Promise<StatResult | null> => {
					if (path === "main.bal") {
						const content = codeRef.current;
						return {
							name: path,
							size: content.length,
							modTime: 0,
							isDir: false,
						};
					}
					return null;
				},
				readDir: (_path: string): Promise<DirEntry[] | null> => {
					throw new Error("not implemented");
				},
				writeFile: (_path: string, _content: string): Promise<boolean> => {
					throw new Error("not implemented");
				},
				remove: (_path: string): Promise<boolean> => {
					throw new Error("not implemented");
				},
				move: (_oldPath: string, _newPath: string): Promise<boolean> => {
					throw new Error("not implemented");
				},
				mkdirAll: (_path: string): Promise<boolean> => {
					throw new Error("not implemented");
				},
			}) satisfies FS,
		[],
	);

	const outputWriter = useMemo(
		() => ({ write: (chunk: string) => setOutput((prev) => prev + chunk) }),
		[],
	);

	return (
		<BallerinaProvider fs={fs} stdout={outputWriter} stderr={outputWriter} colors={false}>
			<RunEditor
				code={code}
				output={output}
				updateCode={updateCode}
				clearOutput={() => setOutput("")}
			/>
		</BallerinaProvider>
	);
}

interface RunEditorProps {
	code: string;
	output: string;
	updateCode: (value: string) => void;
	clearOutput: () => void;
}

function RunEditor({ code, output, updateCode, clearOutput }: RunEditorProps) {
	const { run, isReady } = useBallerina();

	return (
		<main className="min-h-dvh grid place-items-center p-4">
			<section className="w-full max-w-xl space-y-4">
				<div className="flex justify-end">
					<button
						type="button"
						className="border border-zinc-300 px-4 py-2 disabled:opacity-50"
						disabled={!isReady}
						onClick={() => {
							clearOutput();
							void run("main.bal");
						}}
					>
						{isReady ? "Run" : "Loading..."}
					</button>
				</div>

				<textarea
					className="w-full resize-none border border-zinc-300 p-4 font-mono"
					rows={8}
					value={code}
					onChange={(e) => updateCode(e.target.value)}
				/>

				<textarea
					className="w-full resize-none border border-zinc-300 p-4 font-mono"
					rows={8}
					readOnly
					value={output}
				/>
			</section>
		</main>
	);
}
