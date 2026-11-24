import {
	createContext,
	createElement,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

import type { ReactNode } from "react";

import type { Ballerina } from "./core/ballerina";
import type { BallerinaRunOptions, BallerinaRunResult } from "./core/ballerina-core";

export interface BallerinaContextValue {
	ballerina: Ballerina;
	isReady: boolean;
	error: Error | null;
	run: (path: string, options?: BallerinaRunOptions) => Promise<BallerinaRunResult>;
}

const BallerinaContext = createContext<BallerinaContextValue | null>(null);

export interface BallerinaProviderProps {
	ballerina: Ballerina;
	children?: ReactNode;
}

export function BallerinaProvider({ ballerina, children }: BallerinaProviderProps) {
	const [ready, setReady] = useState<Ballerina | null>(null);
	const [failure, setFailure] = useState<{ ballerina: Ballerina; error: Error } | null>(null);

	useEffect(() => {
		let cancelled = false;

		ballerina.init().then(
			() => {
				if (!cancelled) setReady(ballerina);
			},
			(err: unknown) => {
				if (cancelled) return;
				setFailure({
					ballerina,
					error: err instanceof Error ? err : new Error(`[balrun]: ${String(err)}`),
				});
			},
		);

		return () => {
			cancelled = true;
			setFailure(null);
		};
	}, [ballerina]);

	const isReady = ready === ballerina;
	const error = failure?.ballerina === ballerina ? failure.error : null;

	const run = useCallback(
		(path: string, options?: BallerinaRunOptions): Promise<BallerinaRunResult> => {
			if (!isReady)
				return Promise.reject(new Error("[balrun]: runtime instance is not initialized."));
			return ballerina.run(path, options);
		},
		[ballerina, isReady],
	);

	const value = useMemo(
		() => ({ ballerina, isReady, error, run }),
		[ballerina, isReady, error, run],
	);

	return createElement(BallerinaContext.Provider, { value }, children);
}

export function useBallerina(): BallerinaContextValue {
	const value = useContext(BallerinaContext);
	if (!value) throw new Error("[balrun]: useBallerina must be used within a BallerinaProvider.");
	return value;
}

export type UseBallerinaResult = BallerinaContextValue;
