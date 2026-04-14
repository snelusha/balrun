import { defineConfig } from "tsdown";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

export default defineConfig({
	plugins: [
		{
			name: "wasm-inline",
			resolveId(source, importer) {
				if (!source.endsWith(".wasm")) return null;
				// resolve the absolute path relative to the importing file
				const dir = dirname(importer!);
				return resolve(dir, source);
			},
			load(id) {
				if (!id.endsWith(".wasm")) return null;
				const buffer = readFileSync(id);
				const base64 = buffer.toString("base64");
				return {
					code: `export default "data:application/wasm;base64,${base64}";`,
					map: null,
				};
			},
		},
	],
});
