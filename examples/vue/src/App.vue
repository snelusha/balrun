<script setup lang="ts">
import { ref } from "vue";

import { createBallerina } from "@snelusha/balrun/vue";

import type { DirEntry, FS, OpenResult, StatResult } from "@snelusha/balrun";

const DEFAULT_CODE = `import ballerina/io;

public function main() {
    io:println("Hello from Ballerina!");
}`;

const code = ref(DEFAULT_CODE);
const output = ref("no output");

const fs = {
	open: async (path): Promise<OpenResult | null> => {
		if (path === "main.bal") {
			const content = code.value;
			return { content, size: content.length, modTime: 0, isDir: false };
		}
		return null;
	},
	stat: async (path): Promise<StatResult | null> => {
		if (path === "main.bal") {
			const content = code.value;
			return {
				name: path,
				size: content.length,
				modTime: 0,
				isDir: false,
			};
		}
		return null;
	},
	readDir: (_path: string): Promise<DirEntry[] | null> => {
		throw new Error("not implemented");
	},
	writeFile: (_path: string, _content: string): Promise<boolean> => {
		throw new Error("not implemented");
	},
	remove: (_path: string): Promise<boolean> => {
		throw new Error("not implemented");
	},
	move: (_oldPath: string, _newPath: string): Promise<boolean> => {
		throw new Error("not implemented");
	},
	mkdirAll: (_path: string): Promise<boolean> => {
		throw new Error("not implemented");
	},
} satisfies FS;

const outputWriter = {
	write: (chunk: string) => {
		output.value += chunk;
	},
};

const { run, isReady: _isReady } = createBallerina({
	fs,
	stdout: outputWriter,
	stderr: outputWriter,
	colors: false,
});

const _runCode = () => {
	output.value = "";
	void run("main.bal");
};
</script>

<template>
	<main class="min-h-dvh grid place-items-center p-4">
		<section class="w-full max-w-xl space-y-4">
			<div class="flex justify-end">
				<button
					type="button"
					class="border border-zinc-300 px-4 py-2 disabled:opacity-50"
					:disabled="!_isReady"
					@click="_runCode"
				>
					{{ _isReady ? "Run" : "Loading..." }}
				</button>
			</div>

			<textarea
				v-model="code"
				class="w-full resize-none border border-zinc-300 p-4 font-mono"
				rows="8"
			/>

			<textarea
				v-model="output"
				class="w-full resize-none border border-zinc-300 p-4 font-mono"
				rows="8"
				readonly
			/>
		</section>
	</main>
</template>
