import type { FS } from "./fs";
import type { StreamWriter } from "./ballerina";

declare global {
	class Go {
		importObject: WebAssembly.Imports;
		run(instance: WebAssembly.Instance): Promise<void>;
	}

	var run: (
		proxy: FS,
		path: string,
		options?: {
			colors?: boolean;
			stdout?: StreamWriter;
			stderr?: StreamWriter;
		},
	) => Promise<{ error?: string } | null>;
}
