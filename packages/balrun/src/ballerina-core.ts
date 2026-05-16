import type { FS } from "./fs";

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

export interface BallerinaCore {
	run(
		proxy: FS,
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult>;
}
