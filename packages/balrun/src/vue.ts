import { onBeforeUnmount, ref, shallowRef, toValue, watch } from "vue";

import { Ballerina } from "./ballerina";

import type { BallerinaRunOptions, BallerinaRunResult } from "./ballerina-core";
import type { BallerinaOptions } from "./ballerina";
import type { MaybeRefOrGetter } from "vue";

export function createBallerina(
	options: MaybeRefOrGetter<BallerinaOptions> = {},
) {
	const ballerinaRef = shallowRef<Ballerina | null>(null);

	const isReady = ref(false);
	const error = shallowRef<Error | null>(null);

	watch(
		() => {
			const { fs, core, wasmSource, colors, stdout, stderr } = toValue(options);
			return { fs, core, wasmSource, colors, stdout, stderr };
		},
		(opts) => {
			const ballerina = new Ballerina(opts);

			ballerinaRef.value = ballerina;
			isReady.value = false;
			error.value = null;

			ballerina
				.init()
				.then(() => {
					isReady.value = true;
				})
				.catch((err) => {
					error.value = err instanceof Error ? err : new Error(String(err));
				});
		},
		{ immediate: true },
	);

	onBeforeUnmount(() => {
		ballerinaRef.value = null;
	});

	const run = (
		path: string,
		options?: BallerinaRunOptions,
	): Promise<BallerinaRunResult> => {
		if (!ballerinaRef.value || !isReady.value) {
			return Promise.reject(new Error("Ballerina instance not initialized"));
		}
		return ballerinaRef.value.run(path, options);
	};

	return { isReady, error, run };
}

export type VueBallerina = ReturnType<typeof createBallerina>;
