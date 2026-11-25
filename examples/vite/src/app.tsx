import { useRef, useState } from "react";

import { Ballerina, FsError } from "@snelusha/balrun";
import { BallerinaProvider, useBallerina } from "@snelusha/balrun/react";

import type { Fs } from "@snelusha/balrun";
import type { RefObject } from "react";

const DEFAULT_CODE = `import ballerina/io;

public function main() {
    io:println("Hello from Ballerina!");
}`;

function createFs(code: RefObject<string>): Fs {
	const read = (path: string) => {
		if (path !== "main.bal") throw new FsError("ENOENT", path);
		return new TextEncoder().encode(code.current);
	};

	return {
		stat: (path) => ({ type: "file", size: read(path).length, mtimeMs: 0 }),
		readdir: (path) => {
			throw new FsError("ENOENT", path);
		},
		open: (path, flags) => {
			if (flags.write) throw new FsError("EROFS", path);
			const content = read(path);
			return { read: (offset, length) => content.subarray(offset, offset + length) };
		},
	};
}

export default function App() {
	const [code, setCode] = useState(DEFAULT_CODE);
	const [output, setOutput] = useState("no output");

	const codeRef = useRef(DEFAULT_CODE);

	const [ballerina] = useState(() => {
		const writer = { write: (chunk: string) => setOutput((prev) => prev + chunk) };
		return new Ballerina({ fs: createFs(codeRef), stdout: writer, stderr: writer, colors: false });
	});

	const updateCode = (value: string) => {
		codeRef.current = value;
		setCode(value);
	};

	return (
		<BallerinaProvider ballerina={ballerina}>
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
