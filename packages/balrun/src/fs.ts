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
	readDir(path: string): Promise<ReadDirResult>;
	writeFile(path: string, content: string): Promise<boolean>;
	remove(path: string): Promise<boolean>;
	move(oldPath: string, newPath: string): Promise<boolean>;
	mkdirAll(path: string): Promise<boolean>;
}
