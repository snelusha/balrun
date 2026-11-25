/** Splits a path into names, resolving dot segments without leaving the root. */
export function segments(path: string): string[] {
	const names: string[] = [];
	for (const name of path.split("/")) {
		if (name === "..") names.pop();
		else if (name !== "" && name !== ".") names.push(name);
	}
	return names;
}
