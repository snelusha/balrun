import { useCallback, useEffect, useRef, useState } from "react";

import { Ballerina, type BallerinaOptions } from "./ballerina";

import type { BallerinaRunOptions, BallerinaRunResult } from "./ballerina-core";

const DEFAULT_WASM_PATH = new URL("./ballerina.wasm", import.meta.url).href;

export interface WasmLoadingProgress {
	/** Bytes loaded so far. */
	loaded: number;
	/** Total bytes, when the server sends a content-length header. */
	total?: number;
	/** Loading percentage in the range 0-100, when `total` is known. */
	percent?: number;
}

export interface UseBallerinaOptions extends BallerinaOptions {
	/** Called while the WASM binary is being downloaded or read. */
	onProgress?: (progress: WasmLoadingProgress) => void;
}

export interface UseBallerinaResult {
	ballerina: Ballerina | null;
	ready: boolean;
	error: Error | null;
	progress: WasmLoadingProgress | null;
	run: (
		path: string,
		options?: BallerinaRunOptions,
	) => Promise<BallerinaRunResult>;
}

export function useBallerina(
	options: UseBallerinaOptions = {},
): UseBallerinaResult {
	const ballerinaRef = useRef<Ballerina | null>(null);

	const [ready, setReady] = useState(false);
	const [error, setError] = useState<Error | null>(null);
	const [progress, setProgress] = useState<WasmLoadingProgress | null>(null);
	const onProgressRef = useRef(options.onProgress);

	onProgressRef.current = options.onProgress;

	const { fs, core, wasmUrl, colors, stdout, stderr } = options;

	useEffect(() => {
		let disposed = false;
		let instance: Ballerina | null = null;
		const ballerinaOptions: BallerinaOptions = {
			fs,
			core,
			wasmUrl,
			colors,
			stdout,
			stderr,
		};

		ballerinaRef.current = null;
		setReady(false);
		setError(null);
		setProgress(null);

		const handleProgress = (nextProgress: WasmLoadingProgress) => {
			if (disposed) return;
			setProgress(nextProgress);
			onProgressRef.current?.(nextProgress);
		};

		(async () => {
			try {
				const optionsWithCore = ballerinaOptions.core
					? ballerinaOptions
					: {
							...ballerinaOptions,
							core: await import("./wasm-bridge").then(({ WasmBridge }) =>
								WasmBridge.load(
									fetchWithProgress(
										ballerinaOptions.wasmUrl ?? DEFAULT_WASM_PATH,
										handleProgress,
									),
								),
							),
						};

				if (disposed) return;

				instance = new Ballerina(optionsWithCore);
				ballerinaRef.current = instance;
				await instance.init();

				if (disposed || ballerinaRef.current !== instance) return;
				setReady(true);
			} catch (err) {
				if (disposed) return;
				setError(err instanceof Error ? err : new Error(String(err)));
				setReady(false);
				setProgress(null);
			}
		})();

		return () => {
			disposed = true;
			if (!instance || ballerinaRef.current === instance) {
				ballerinaRef.current = null;
				setReady(false);
				setError(null);
				setProgress(null);
			}
		};
	}, [fs, core, wasmUrl, colors, stdout, stderr]);

	const run = useCallback(
		(
			path: string,
			options?: BallerinaRunOptions,
		): Promise<BallerinaRunResult> => {
			if (!ballerinaRef.current)
				return Promise.reject(new Error("Ballerina instance not initialized"));
			return ballerinaRef.current.run(path, options);
		},
		[],
	);

	return {
		ballerina: ballerinaRef.current,
		ready,
		error,
		progress,
		run,
	};
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
		reportProgress(onProgress, buffer.byteLength, total ?? buffer.byteLength);
		return new Response(buffer, response);
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	reportProgress(onProgress, loaded, total);

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.byteLength;
		reportProgress(onProgress, loaded, total);
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

function reportProgress(
	onProgress: (progress: WasmLoadingProgress) => void,
	loaded: number,
	total?: number,
): void {
	onProgress({
		loaded,
		total,
		percent: total && total > 0 ? Math.min(100, (loaded / total) * 100) : undefined,
	});
}
