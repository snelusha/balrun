import type { FS } from "./fs";

declare global {
	class Go {
		importObject: WebAssembly.Imports;
		run(instance: WebAssembly.Instance): Promise<void>;
	}

	var run: (
		proxy: FS,
		path: string,
		options?: { colors: boolean },
	) => { error?: string } | null;
}
