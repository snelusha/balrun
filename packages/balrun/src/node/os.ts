import { spawn, type ChildProcess } from "node:child_process";
import { homedir, userInfo } from "node:os";

import type { OSPlatform, ProcessPlatform } from "../core/os";

export class NodeOSPlatform implements OSPlatform {
	async getEnv(name: string): Promise<string> {
		return process.env[name] ?? "";
	}

	async getUsername(): Promise<string> {
		try {
			return userInfo().username;
		} catch {
			return "";
		}
	}

	async getUserHome(): Promise<string> {
		try {
			return homedir();
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
	private child: ChildProcess;
	private stdout: Uint8Array[] = [];
	private stderr: Uint8Array[] = [];
	private spawnResult: Promise<void>;
	private exitCode: Promise<number>;

	constructor(child: ChildProcess) {
		this.child = child;
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
