export type StreamWriter = {
	write(chunk: string): void;
};

export interface BallerinaRunOptions {
	colors?: boolean;
	stdout?: StreamWriter;
	stderr?: StreamWriter;
}

export type BallerinaRunResult = { error?: string } | null;
