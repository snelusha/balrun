import { useCallback, useMemo } from "react";

import { Ballerina } from "./ballerina";

import type { BallerinaOptions, BallerinaRunOptions } from "./ballerina";

export interface UseBallerinaResult {
	run(
		path: string,
		options?: BallerinaRunOptions,
	): Promise<{ error?: string } | null>;
}

export function useBallerina(options?: BallerinaOptions): UseBallerinaResult {
	const ballerina = useMemo(
		() => new Ballerina(options),
		[options?.colors, options?.stderr, options?.stdout, options?.fs],
	);

	const run = useCallback(
		(path: string, runOptions?: BallerinaRunOptions) =>
			ballerina.run(path, runOptions),
		[ballerina],
	);

	return { run };
}
