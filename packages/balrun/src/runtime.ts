export function isNodeRuntime(): boolean {
	return typeof process !== "undefined" && !!process.versions?.node;
}
