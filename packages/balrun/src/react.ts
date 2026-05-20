import { useCallback, useEffect, useRef } from "react";

import { Ballerina, type BallerinaOptions } from "./ballerina";

import type { BallerinaRunOptions, BallerinaRunResult } from "./ballerina-core";

export interface UseBallerinaOptions extends BallerinaOptions {
	onReady?: (ballerina: Ballerina) => void;
}

export function useBallerina(options?: UseBallerinaOptions) {
	const ballerinaRef = useRef<Ballerina | null>(null);
	const callbackRef = useRef({
		onReady: options?.onReady,
	});

	callbackRef.current = { onReady: options?.onReady };

	useEffect(() => {
		const ballerina = new Ballerina(options);
		ballerinaRef.current = ballerina;

		ballerina.init().then(() => {
			callbackRef.current.onReady?.(ballerina);
		});

		return () => {
			ballerinaRef.current = null;
		};
	}, [options]);

	const run = useCallback(
		(
			path: string,
			options: BallerinaRunOptions,
		): Promise<BallerinaRunResult> => {
			if (!ballerinaRef.current)
				return Promise.reject(new Error("Ballerina instance not initialized"));
			return ballerinaRef.current.run(path, options);
		},
		[],
	);

	return { run };
}
