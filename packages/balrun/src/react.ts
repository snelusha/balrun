import { useCallback, useEffect, useRef, useState } from "react";

import { Ballerina, type BallerinaOptions } from "./ballerina";

import type { BallerinaRunOptions, BallerinaRunResult } from "./ballerina-core";

export type UseBallerinaOptions = BallerinaOptions;

export interface UseBallerinaResult {
	ballerina: Ballerina | null;
	ready: boolean;
	error: Error | null;
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

	useEffect(() => {
		let disposed = false;
		const instance = new Ballerina(options);

		ballerinaRef.current = instance;
		setReady(false);
		setError(null);

		instance.init().then(
			() => {
				if (disposed || ballerinaRef.current !== instance) return;
				setReady(true);
			},
			(err) => {
				if (disposed || ballerinaRef.current !== instance) return;
				setError(err instanceof Error ? err : new Error(String(err)));
				setReady(false);
			},
		);

		return () => {
			disposed = true;
			if (ballerinaRef.current === instance) {
				ballerinaRef.current = null;
				setReady(false);
				setError(null);
			}
		};
	}, [options]);

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
		run,
	};
}
