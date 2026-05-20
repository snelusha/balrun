import { useCallback, useEffect, useRef } from "react";

import { Ballerina, type BallerinaOptions } from "./ballerina";

import type { BallerinaRunOptions, BallerinaRunResult } from "./ballerina-core";

export function useBallerina(options?: BallerinaOptions) {
	const ballerinaRef = useRef<Ballerina | null>(null);

	useEffect(() => {
		ballerinaRef.current = new Ballerina(options);

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
