import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "tsdown";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const wasm = fileURLToPath(new URL("../ballerina-wasm/dist/ballerina.wasm", import.meta.url));

export default defineConfig({
	entry: ["src/node.ts", "src/web.ts", "src/react.ts"],
	deps: {
		neverBundle: ["react"],
	},
	define: {
		__BALRUN_VERSION__: JSON.stringify(version),
	},
	copy: [wasm],
	hooks: {
		"build:prepare": () => {
			if (!existsSync(wasm))
				throw new Error(`${wasm} is missing; build packages/ballerina-wasm first.`);
		},
	},
});
