import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Ballerina, type BallerinaOptions } from "./ballerina";

import type { BallerinaRunOptions, BallerinaRunResult } from "./ballerina-core";

export function useBallerina(options?: BallerinaOptions) {
	const ballerinaRef = useRef<Ballerina | null>(null);

	const [isReady, setIsReady] = useState(false);
	const [error, setError] = useState<Error | null>(null);

	const opts = useMemo(() => options ?? {}, [options]);

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
					setError(err instanceof Error ? err : new Error(String(err))),
			);

		return () => {
			cancelled = true;
			if (ballerinaRef.current === ballerina) {
				ballerinaRef.current = null;
			}
		};
	}, [opts]);

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
