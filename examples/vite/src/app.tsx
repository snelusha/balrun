import { useState } from "react";

import { Ballerina, MemFS } from "@snelusha/balrun";
import { BallerinaProvider, useBallerina } from "@snelusha/balrun/react";

const DEFAULT_CODE = `import ballerina/io;

public function main() {
    io:println("Hello from Ballerina!");
}`;

export default function App() {
	const [code, setCode] = useState(DEFAULT_CODE);
	const [output, setOutput] = useState("no output");

	const [fs] = useState(() => new MemFS({ "main.bal": DEFAULT_CODE }));

	const [ballerina] = useState(() => {
		const writer = { write: (chunk: string) => setOutput((prev) => prev + chunk) };
		return new Ballerina({ fs, stdout: writer, stderr: writer, colors: false });
	});

	const updateCode = (value: string) => {
		fs.writeFile("main.bal", value);
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
