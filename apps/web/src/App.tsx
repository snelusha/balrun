import { Button } from "@/components/ui/button";
import { useEffect, useState } from "react";
import {
	useBallerina,
	WasmBridge,
	type BallerinaCore,
	type FS,
	type WasmLoadingProgress,
} from "@snelusha/balrun";

class MemFS implements FS {
	private files = new Map<string, string>();

	constructor(files: Record<string, string>) {
		for (const [path, content] of Object.entries(files)) {
			this.files.set(path, content);
		}
	}

	async open(path: string) {
		const content = this.files.get(path);
		return content == null
			? null
			: { content, size: content.length, modTime: 0, isDir: false };
	}

	async stat(path: string) {
		if (path === ".") {
			return { name: ".", size: 0, modTime: 0, isDir: true };
		}
		const content = this.files.get(path);
		return content == null
			? null
			: { name: path, size: content.length, modTime: 0, isDir: false };
	}

	async readDir(path: string) {
		if (path === ".") {
			return Array.from(this.files.keys()).map((name) => ({
				name,
				isDir: false,
			}));
		}
		return null;
	}

	async writeFile(): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	async remove(): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	async move(): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
	async mkdirAll(): Promise<boolean> {
		throw new Error("Method not implemented.");
	}
}

const fs = new MemFS({
	"main.bal": `import ballerina/io;\npublic function main() { io:println("Hello, World!"); }`,
});

const wasmUrl = new URL("@snelusha/balrun/ballerina.wasm", import.meta.url)
	.href;

export function App() {
	return (
		<div className="grid min-h-svh gap-6 p-6 md:grid-cols-2">
			<BuiltInProgressDemo />
			<CustomCoreProgressDemo />
		</div>
	);
}

function BuiltInProgressDemo() {
	const { run, ready, error, progress } = useBallerina({ fs });

	useEffect(() => {
		if (ready) console.log("Built-in progress runtime is ready");
	}, [ready]);

	return (
		<DemoCard
			title="useBallerina progress"
			description="The hook fetches the WASM and exposes progress directly."
			ready={ready}
			error={error}
			progress={progress}
			onRun={() => run("main.bal")}
		/>
	);
}

function CustomCoreProgressDemo() {
	const [core, setCore] = useState<BallerinaCore | null>(null);
	const [progress, setProgress] = useState<WasmLoadingProgress | null>(null);
	const [error, setError] = useState<Error | null>(null);

	useEffect(() => {
		let disposed = false;

		(async () => {
			try {
				const response = fetchWithProgress(wasmUrl, (nextProgress) => {
					if (!disposed) setProgress(nextProgress);
				});
				const bridge = await WasmBridge.load(response);
				if (!disposed) setCore(bridge);
			} catch (err) {
				if (!disposed) {
					setError(err instanceof Error ? err : new Error(String(err)));
				}
			}
		})();

		return () => {
			disposed = true;
		};
	}, []);

	if (!core) {
		return (
			<DemoCard
				title="Custom core progress"
				description="This component owns the fetch, creates a WasmBridge, then passes the core into useBallerina."
				ready={false}
				error={error}
				progress={progress}
			/>
		);
	}

	return <CustomCoreRunner core={core} progress={progress} />;
}

function CustomCoreRunner({
	core,
	progress,
}: {
	core: BallerinaCore;
	progress: WasmLoadingProgress | null;
}) {
	const { run, ready, error } = useBallerina({ fs, core });

	return (
		<DemoCard
			title="Custom core progress"
			description="The hook receives a preloaded core, so the progress belongs to this component."
			ready={ready}
			error={error}
			progress={progress}
			onRun={() => run("main.bal")}
		/>
	);
}

function DemoCard({
	title,
	description,
	ready,
	error,
	progress,
	onRun,
}: {
	title: string;
	description: string;
	ready: boolean;
	error: Error | null;
	progress: WasmLoadingProgress | null;
	onRun?: () => Promise<unknown>;
}) {
	const percent = progress?.percent;

	return (
		<section className="flex min-w-0 flex-col justify-between rounded-lg border p-6 text-sm leading-loose">
			<div className="space-y-4">
				<div>
					<h1 className="font-medium">{title}</h1>
					<p className="text-muted-foreground">{description}</p>
				</div>

				{error ? (
					<p className="text-destructive">{error.message}</p>
				) : ready ? (
					<p>Runtime ready.</p>
				) : (
					<div className="space-y-2">
						<p>Loading Ballerina runtime...</p>
						<progress className="w-full" value={percent ?? 0} max={100} />
						{percent != null && <p>{Math.round(percent)}%</p>}
					</div>
				)}

				<Button
					className="mt-2"
					disabled={!ready || !onRun}
					onClick={async () => {
						const result = await onRun?.();
						console.log(result);
					}}
				>
					Run main.bal
				</Button>
			</div>

			<div className="mt-6 font-mono text-xs text-muted-foreground">
				(Press <kbd>d</kbd> to toggle dark mode)
			</div>
		</section>
	);
}

async function fetchWithProgress(
	url: string,
	onProgress: (progress: WasmLoadingProgress) => void,
): Promise<Response> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Failed to load WASM: ${response.status} ${response.statusText}`,
		);
	}

	const total = parseContentLength(response.headers.get("content-length"));
	if (!response.body) {
		const buffer = await response.arrayBuffer();
		onProgress(toProgress(buffer.byteLength, total ?? buffer.byteLength));
		return new Response(buffer, response);
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	onProgress(toProgress(loaded, total));

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.byteLength;
		onProgress(toProgress(loaded, total));
	}

	const bytes = new Uint8Array(loaded);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return new Response(bytes, response);
}

function parseContentLength(value: string | null): number | undefined {
	if (!value) return undefined;
	const length = Number(value);
	return Number.isFinite(length) && length >= 0 ? length : undefined;
}

function toProgress(loaded: number, total?: number): WasmLoadingProgress {
	return {
		loaded,
		total,
		percent:
			total && total > 0 ? Math.min(100, (loaded / total) * 100) : undefined,
	};
}

export default App;
