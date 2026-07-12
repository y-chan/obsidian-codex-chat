import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

export function expandEnvironmentVariables(value: string): string {
	return value
		.replace(/%([^%]+)%/g, (_, name: string) => process.env[name] ?? `%${name}%`)
		.replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, name: string) => process.env[name] ?? `$env:${name}`)
		.replace(/^~(?=$|[\\/])/, os.homedir());
}

export function normalizeFilesystemPath(value: string, platform: NodeJS.Platform = process.platform): string {
	const expanded = expandEnvironmentVariables(value.trim());
	if (platform === 'win32') {
		const gitBashMatch = expanded.match(/^\/([A-Za-z])(?:\/|$)(.*)$/);
		const windowsValue = gitBashMatch ? `${gitBashMatch[1]?.toUpperCase() ?? ''}:\\${gitBashMatch[2] ?? ''}` : expanded;
		return path.win32.normalize(windowsValue.replaceAll('/', '\\'));
	}
	return path.normalize(expanded);
}

export function pathsEqual(left: string, right: string, platform: NodeJS.Platform = process.platform): boolean {
	const normalizedLeft = normalizeFilesystemPath(left, platform);
	const normalizedRight = normalizeFilesystemPath(right, platform);
	return platform === 'win32' ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

export function codexHomeCandidates(): string[] {
	const values = [
		process.env.CODEX_HOME,
		process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.codex') : undefined,
		process.env.HOME ? path.join(process.env.HOME, '.codex') : undefined,
		path.join(os.homedir(), '.codex'),
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'codex') : undefined,
		process.env.APPDATA ? path.join(process.env.APPDATA, 'codex') : undefined,
	];
	return [...new Set(values.filter((value): value is string => Boolean(value)).map((value) => normalizeFilesystemPath(value)))];
}

export function shortenPath(value: string, maxLength = 64): string {
	if (value.length <= maxLength) return value;
	return `…${value.slice(-(maxLength - 1))}`;
}

export async function validateWorkingDirectory(value: string, platform: NodeJS.Platform = process.platform): Promise<string> {
	const normalized = normalizeFilesystemPath(value, platform);
	const pathApi = platform === 'win32' ? path.win32 : path;
	if (!normalized || !pathApi.isAbsolute(normalized)) throw new Error('Working directory must be an absolute path.');
	try {
		const stat = await fs.stat(normalized);
		if (!stat.isDirectory()) throw new Error(`Working directory is not a directory: ${normalized}`);
	} catch (error) {
		if (error instanceof Error && error.message.includes('not a directory')) throw error;
		throw new Error(`Working directory does not exist: ${normalized}`);
	}
	return normalized;
}
