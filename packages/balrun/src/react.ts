import {
	createContext,
	createElement,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";

import { Ballerina } from "./ballerina";

import type { ReactNode } from "react";

import type { BallerinaRunOptions, BallerinaRunResult, BallerinaStopMode } from "./ballerina-core";
import type { BallerinaOptions } from "./ballerina";

export interface BallerinaContextValue {
	isReady: boolean;
	isRunning: boolean;
	error: Error | null;
	run: (path: string, options?: BallerinaRunOptions) => Promise<BallerinaRunResult>;
	stop: (mode?: BallerinaStopMode) => Promise<boolean>;
}

const BallerinaContext = createContext<BallerinaContextValue | null>(null);

export interface BallerinaProviderProps extends BallerinaOptions {
	children?: ReactNode;
}

export function BallerinaProvider({ children, ...options }: BallerinaProviderProps) {
	const ballerinaRef = useRef<Ballerina | null>(null);

	const [isReady, setIsReady] = useState(false);
	const [isRunning, setIsRunning] = useState(false);
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
		setIsRunning(false);
		setError(null);

		ballerina
			.init()
			.then(() => !cancelled && setIsReady(true))
			.catch(
				(err) =>
					!cancelled &&
					setError(err instanceof Error ? err : new Error(`[balrun]: ${String(err)}`)),
			);

		return () => {
			cancelled = true;
			if (ballerinaRef.current === ballerina) ballerinaRef.current = null;
		};
	}, [opts]);

	const run = useCallback(
		async (path: string, options?: BallerinaRunOptions): Promise<BallerinaRunResult> => {
			if (!ballerinaRef.current || !isReady)
				throw new Error("[balrun]: runtime instance is not initialized.");
			setIsRunning(true);
			try {
				return await ballerinaRef.current.run(path, options);
			} finally {
				setIsRunning(false);
			}
		},
		[isReady],
	);

	const stop = useCallback(
		(mode?: BallerinaStopMode): Promise<boolean> => {
			if (!ballerinaRef.current || !isReady)
				return Promise.reject(new Error("[balrun]: runtime instance is not initialized."));
			return ballerinaRef.current.stop(mode);
		},
		[isReady],
	);

	return createElement(
		BallerinaContext.Provider,
		{ value: { isReady, isRunning, error, run, stop } },
		children,
	);
}

export function useBallerina(): BallerinaContextValue {
	const value = useContext(BallerinaContext);
	if (!value) throw new Error("[balrun]: useBallerina must be used within a BallerinaProvider.");
	return value;
}

export type UseBallerinaResult = BallerinaContextValue;
