export type Environment = Map<string, string>;

const NODE_OS_MODULE = "node:os";
const NODE_CHILD_PROCESS_MODULE = "node:child_process";

export interface OSPlatform {
	getEnv(name: string): Promise<string>;
	getUsername(): Promise<string>;
	getUserHome(): Promise<string>;
	setEnv(key: string, value: string): Promise<void>;
	unsetEnv(key: string): Promise<void>;
	listEnv(): Promise<Record<string, string>>;
	exec(
		command: string,
		args: string[],
		envOverride: Record<string, string>,
	): Promise<ProcessPlatform>;
}

export interface ProcessPlatform {
	waitForExit(): Promise<number>;
	readStdout(): Promise<Uint8Array>;
	readStderr(): Promise<Uint8Array>;
	kill(): void;
}

export function createOSPlatform(environment?: Environment): OSPlatform {
	return supportsNodeOS() ? new NodeOSPlatform() : new BrowserOSPlatform(environment);
}

class BrowserOSPlatform implements OSPlatform {
	private environment: Environment;

	constructor(environment: Environment = new Map()) {
		this.environment = new Map(environment);
	}

	async getEnv(name: string): Promise<string> {
		return this.environment.get(name) ?? "";
	}

	async setEnv(key: string, value: string): Promise<void> {
		this.environment.set(key, value);
	}

	async unsetEnv(key: string): Promise<void> {
		this.environment.delete(key);
	}

	async listEnv(): Promise<Record<string, string>> {
		return Object.fromEntries(this.environment);
	}

	async getUsername(): Promise<string> {
		return unsupportedOS();
	}

	async getUserHome(): Promise<string> {
		return unsupportedOS();
	}

	async exec(): Promise<ProcessPlatform> {
		return unsupportedOS();
	}
}

class NodeOSPlatform implements OSPlatform {
	async getEnv(name: string): Promise<string> {
		return process.env[name] ?? "";
	}

	async getUsername(): Promise<string> {
		try {
			return (await import(/* @vite-ignore */ NODE_OS_MODULE)).userInfo().username;
		} catch {
			return "";
		}
	}

	async getUserHome(): Promise<string> {
		try {
			return (await import(/* @vite-ignore */ NODE_OS_MODULE)).homedir();
		} catch {
			return "";
		}
	}

	async setEnv(key: string, value: string): Promise<void> {
		process.env[key] = value;
	}

	async unsetEnv(key: string): Promise<void> {
		delete process.env[key];
	}

	async listEnv(): Promise<Record<string, string>> {
		return Object.fromEntries(
			Object.entries(process.env).flatMap(([key, value]) =>
				value === undefined ? [] : [[key, value]],
			),
		);
	}

	async exec(
		command: string,
		args: string[],
		envOverride: Record<string, string>,
	): Promise<ProcessPlatform> {
		const { spawn } = await import(/* @vite-ignore */ NODE_CHILD_PROCESS_MODULE);
		const child = spawn(command, args, {
			env: { ...process.env, ...envOverride },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const nodeProcess = new NodeProcess(child);
		await nodeProcess.waitForSpawn();
		return nodeProcess;
	}
}

class NodeProcess implements ProcessPlatform {
	private stdout: Uint8Array[] = [];
	private stderr: Uint8Array[] = [];
	private spawnResult: Promise<void>;
	private exitCode: Promise<number>;

	constructor(private child: import("node:child_process").ChildProcess) {
		child.stdout?.on("data", (chunk: Uint8Array) => this.stdout.push(chunk));
		child.stderr?.on("data", (chunk: Uint8Array) => this.stderr.push(chunk));

		let rejectExit: (error: Error) => void = () => {};
		this.exitCode = new Promise((resolve, reject) => {
			rejectExit = reject;
			child.once("close", (code) => resolve(code ?? -1));
		});
		void this.exitCode.catch(() => {});
		this.spawnResult = new Promise((resolve, reject) => {
			child.once("spawn", resolve);
			child.once("error", (error) => {
				rejectExit(error);
				reject(error);
			});
		});
	}

	waitForSpawn(): Promise<void> {
		return this.spawnResult;
	}

	waitForExit(): Promise<number> {
		return this.exitCode;
	}

	async readStdout(): Promise<Uint8Array> {
		await this.exitCode;
		return concat(this.stdout);
	}

	async readStderr(): Promise<Uint8Array> {
		await this.exitCode;
		return concat(this.stderr);
	}

	kill(): void {
		this.child.kill();
	}
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

function supportsNodeOS(): boolean {
	return typeof process !== "undefined" && !!process.versions?.node;
}

function unsupportedOS(): never {
	throw new Error("[balrun]: OS operation is not supported in browser environments.");
}
