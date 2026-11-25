import { useEffect, useState } from "react";

import { Ballerina, FsError, OPFS } from "@snelusha/balrun/web";
import { BallerinaProvider, useBallerina } from "@snelusha/balrun/react";

const DEFAULT_CODE = `import ballerina/io;

public function main() {
    io:println("Hello from Ballerina!");
}`;

const fs = new OPFS({ root: "example-vite" });

async function loadCode(): Promise<string> {
	try {
		return new TextDecoder().decode(await fs.readFile("main.bal"));
	} catch (error) {
		if (!(error instanceof FsError) || error.code !== "ENOENT") throw error;
		await fs.writeFile("main.bal", DEFAULT_CODE);
		return DEFAULT_CODE;
	}
}

export default function App() {
	const [code, setCode] = useState<string | null>(null);
	const [output, setOutput] = useState("no output");

	const [ballerina] = useState(() => {
		const writer = { write: (chunk: string) => setOutput((prev) => prev + chunk) };
		return new Ballerina({ fs, stdout: writer, stderr: writer, colors: false });
	});

	const showError = (error: unknown) => setOutput(String(error));

	useEffect(() => {
		let cancelled = false;
		loadCode().then(
			(value) => {
				if (!cancelled) setCode(value);
			},
			(error: unknown) => {
				if (!cancelled) showError(error);
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	const updateCode = (value: string) => {
		setCode(value);
		// Operations run in order, so a later run sees this write.
		fs.writeFile("main.bal", value).catch(showError);
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
	code: string | null;
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
						disabled={!isReady || code === null}
						onClick={() => {
							clearOutput();
							void run("main.bal");
						}}
					>
						{isReady && code !== null ? "Run" : "Loading..."}
					</button>
				</div>

				<textarea
					className="w-full resize-none border border-zinc-300 p-4 font-mono"
					rows={8}
					value={code ?? ""}
					disabled={code === null}
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
