import { useCallback, useEffect, useRef, useState } from "react";

import { Ballerina, type BallerinaOptions } from "./ballerina";

import type { BallerinaRunOptions, BallerinaRunResult } from "./ballerina-core";

export function useBallerina(options?: BallerinaOptions) {
	const ballerinaRef = useRef<Ballerina | null>(null);

	const [isReady, setIsReady] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	const { fs, core, wasmUrl, colors, stdout, stderr } = options ?? {};

	useEffect(() => {
		let cancelled = false;
		const ballerina = new Ballerina({
			fs,
			core,
			wasmUrl,
			colors,
			stdout,
			stderr,
		});

		ballerinaRef.current = ballerina;
		setIsReady(false);
		setError(null);

		ballerina
			.init()
			.then(() => !cancelled && setIsReady(true))
			.catch(
				(err) =>
					!cancelled &&
					setError(err instanceof Error ? err : new Error(String(err))),
			);

		return () => {
			cancelled = true;
			ballerinaRef.current = null;
		};
	}, [fs, core, wasmUrl, colors, stdout, stderr]);

	const run = useCallback(
		(
			path: string,
			options?: BallerinaRunOptions,
		): Promise<BallerinaRunResult> => {
			if (!ballerinaRef.current || !isReady) {
				return Promise.reject(new Error("Ballerina instance not initialized"));
			}
			return ballerinaRef.current.run(path, options);
		},
		[isReady],
	);

	return { isReady, error, run };
}

export type UseBallerinaResult = ReturnType<typeof useBallerina>;
