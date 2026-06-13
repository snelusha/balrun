import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/fs/node.ts", "src/react.ts", "src/vue.ts"],
	deps: {
		neverBundle: ["react", "vue"],
	},
});
