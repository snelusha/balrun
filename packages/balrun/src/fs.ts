export type OpenResult = {
	content: string;
	size: number;
	modTime: number;
	isDir: boolean;
} | null;

export type StatResult = {
	name: string;
	size: number;
	modTime: number;
	isDir: boolean;
} | null;

export type ReadDirResult = { name: string; isDir: boolean }[] | null;

export interface FS {
	open(path: string): Promise<OpenResult>;
	stat(path: string): Promise<StatResult>;
	readDir(path: string): ReadDirResult;
	writeFile(path: string, content: string): boolean;
	remove(path: string): boolean;
	move(oldPath: string, newPath: string): boolean;
	mkdirAll(path: string): boolean;
}
