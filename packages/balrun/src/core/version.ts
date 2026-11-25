declare const __BALRUN_VERSION__: string;

export const BALRUN_VERSION =
	typeof __BALRUN_VERSION__ === "string" ? __BALRUN_VERSION__ : "0.0.0-dev";
