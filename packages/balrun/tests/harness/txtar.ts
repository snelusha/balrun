export interface TxtarFile {
	name: string;
	data: string;
}

const MARKER = /^-- (.+?) --[ \t]*$/;
/** A body line that reads as a marker is stored with a leading backslash. */
const ESCAPED_MARKER = /^\\+-- .+? --[ \t]*$/;

export function parseTxtar(text: string): TxtarFile[] {
	const files: TxtarFile[] = [];
	let current: { name: string; lines: string[] } | undefined;
	const finish = () => {
		if (current) files.push({ name: current.name, data: current.lines.join("") });
	};

	for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const marker = MARKER.exec(line.replace(/\r?\n$/, ""));
		if (marker?.[1]) {
			finish();
			current = { name: marker[1], lines: [] };
		} else {
			const bare = line.replace(/\r?\n$/, "");
			current?.lines.push(ESCAPED_MARKER.test(bare) ? line.slice(1) : line);
		}
	}
	finish();
	return files;
}

export function formatTxtar(files: TxtarFile[]): string {
	return files
		.map(({ name, data }) => {
			const escaped = data
				.split("\n")
				.map((line) => {
					const bare = line.replace(/\r$/, "");
					return MARKER.test(bare) || ESCAPED_MARKER.test(bare) ? `\\${line}` : line;
				})
				.join("\n");
			const body = escaped === "" || escaped.endsWith("\n") ? escaped : `${escaped}\n`;
			return `-- ${name} --\n${body}`;
		})
		.join("");
}
