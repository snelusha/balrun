export type OpenResult = {
	content: string;
	size: number;
	modTime: number;
	isDir: boolean;
};

export type StatResult = {
	name: string;
	size: number;
	modTime: number;
	isDir: boolean;
};

export type DirEntry = {
	name: string;
	isDir: boolean;
};

export interface FS {
	open(path: string): Promise<OpenResult | null>;
	stat(path: string): Promise<StatResult | null>;
	readDir(path: string): Promise<DirEntry[] | null>;
	writeFile(path: string, content: string): Promise<boolean>;
	remove(path: string): Promise<boolean>;
	move(oldPath: string, newPath: string): Promise<boolean>;
	mkdirAll(path: string): Promise<boolean>;
}
