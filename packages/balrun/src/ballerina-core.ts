import type { FS } from "./fs/core";

export type StreamWriter = {
	write: (chunk: string) => void;
};

export interface BallerinaRunOptions {
	/** Whether ANSI colors should be emitted. Defaults to `true`. */
	colors?: boolean;
	stdout?: StreamWriter;
	stderr?: StreamWriter;
}

export type BallerinaRunResult = { error?: string } | null;

export type BallerinaStopMode = "graceful" | "immediate";

export interface BallerinaCore {
	run(proxy: FS, path: string, options?: BallerinaRunOptions): Promise<BallerinaRunResult>;
	stop(mode?: BallerinaStopMode): Promise<boolean>;
}
