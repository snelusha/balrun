export interface TxtarFile {
	name: string;
	data: string;
}

const MARKER = /^-- (.+?) --[ \t]*$/;

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
			current?.lines.push(line);
		}
	}
	finish();
	return files;
}

export function formatTxtar(files: TxtarFile[]): string {
	return files
		.map(({ name, data }) => {
			const body = data === "" || data.endsWith("\n") ? data : `${data}\n`;
			return `-- ${name} --\n${body}`;
		})
		.join("");
}
