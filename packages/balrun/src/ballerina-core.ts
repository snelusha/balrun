import type { FS } from "./fs/core";
import type { HTTPDispatchRequest, HTTPListenerReady, HTTPListenerResponse } from "./http-listener";
import type { Environment } from "./os";

export type StreamWriter = {
	write: (chunk: string) => void;
};

export interface BallerinaRunOptions {
	/** Whether ANSI colors should be emitted. Defaults to `true`. */
	colors?: boolean;
	stdout?: StreamWriter;
	stderr?: StreamWriter;
	onListenerReady?: (listener: HTTPListenerReady) => void;
	/** Environment exposed to Ballerina when running in a browser. */
	env?: Environment;
}

export type BallerinaRunResult = number;
export type BallerinaStopMode = "graceful" | "immediate";

/** Identifies the interpreter compiled into the loaded WASM binary. */
export interface BallerinaInterpreterVersion {
	/** Exact upstream release tag, or null when the interpreter was built from an untagged commit. */
	version: string | null;
	/** Full Git commit SHA of the upstream interpreter source. */
	commit: string;
}

export interface BallerinaCore {
	getInterpreterVersion(): BallerinaInterpreterVersion;
	run(proxy: FS, path: string, options?: BallerinaRunOptions): Promise<BallerinaRunResult>;
	stop(mode: BallerinaStopMode): boolean;
	dispatchHttpRequest(request: HTTPDispatchRequest): Promise<HTTPListenerResponse>;
}
