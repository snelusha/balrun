import type { FS } from "./fs/core";
import type { HTTPDispatchRequest, HTTPListenerReady, HTTPListenerResponse } from "./http-listener";

export type StreamWriter = {
	write: (chunk: string) => void;
};

export interface BallerinaRunOptions {
	/** Whether ANSI colors should be emitted. Defaults to `true`. */
	colors?: boolean;
	stdout?: StreamWriter;
	stderr?: StreamWriter;
	onListenerReady?: (listener: HTTPListenerReady) => void;
}

export type BallerinaRunResult = number;
export type BallerinaStopMode = "graceful" | "immediate";

export interface BallerinaCore {
	run(proxy: FS, path: string, options?: BallerinaRunOptions): Promise<BallerinaRunResult>;
	stop(mode: BallerinaStopMode): boolean;
	dispatchHttpRequest(request: HTTPDispatchRequest): Promise<HTTPListenerResponse>;
}
