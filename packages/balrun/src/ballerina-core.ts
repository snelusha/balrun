import type { FS } from "./fs";
import type { BallerinaRunOptions, BallerinaRunResult } from "./types";

export interface BallerinaCore {
	run(
		proxy: FS,
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult>;
}
