import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Ballerina } from "./ballerina";

import type { BallerinaRunOptions, BallerinaRunResult } from "./ballerina-core";
import type { BallerinaOptions } from "./ballerina";

export function useBallerina(options: BallerinaOptions = {}) {
	const ballerinaRef = useRef<Ballerina | null>(null);

	const [isReady, setIsReady] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	const { fs, core, wasmSource, colors, stdout, stderr } = options;

	const opts = useMemo(
		() => ({ fs, core, wasmSource, colors, stdout, stderr }),
		[fs, core, wasmSource, colors, stdout, stderr],
	);

	useEffect(() => {
		let cancelled = false;
		const ballerina = new Ballerina(opts);

		ballerinaRef.current = ballerina;
		setIsReady(false);
		setError(null);

		ballerina
			.init()
			.then(() => !cancelled && setIsReady(true))
			.catch(
				(err) =>
					!cancelled &&
					setError(
						err instanceof Error ? err : new Error(`[balrun]: ${String(err)}`),
					),
			);

		return () => {
			cancelled = true;
			if (ballerinaRef.current === ballerina) ballerinaRef.current = null;
		};
	}, [opts]);

	const run = useCallback(
		(
			path: string,
			options?: BallerinaRunOptions,
		): Promise<BallerinaRunResult> => {
			if (!ballerinaRef.current || !isReady)
				return Promise.reject(
					new Error("[balrun]: runtime instance is not initialized."),
				);
			return ballerinaRef.current.run(path, options);
		},
		[isReady],
	);

	return { isReady, error, run };
}

export type UseBallerinaResult = ReturnType<typeof useBallerina>;
