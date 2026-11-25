export type Environment = Map<string, string>;

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

export class EnvOSPlatform implements OSPlatform {
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

function unsupportedOS(): never {
	throw new Error("[balrun]: OS operation is not supported in browser environments.");
}
