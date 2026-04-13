import type { FS } from "./fs";

declare global {
	class Go {
		importObject: WebAssembly.Imports;
		run(instance: WebAssembly.Instance): Promise<void>;
	}

	var run: (
		proxy: FS,
		path: string,
		options?:
			| boolean
			| {
					colors: boolean;
					stdout?: { write(s: string): void };
					stderr?: { write(s: string): void };
			  },
	) => { error?: string } | null;
}

export {};
