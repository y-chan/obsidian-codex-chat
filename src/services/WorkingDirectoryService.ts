import { App, FileSystemAdapter, TFile } from 'obsidian';
import path from 'node:path';
import { normalizeFilesystemPath, validateWorkingDirectory } from '../utils/paths';

export class WorkingDirectoryService {
	constructor(private readonly app: App) {}

	getVaultRoot(): string | undefined {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return undefined;
		return normalizeFilesystemPath(adapter.getBasePath());
	}

	getCurrentFileDirectory(): string | undefined {
		const root = this.getVaultRoot();
		const file = this.app.workspace.getActiveFile();
		if (!root || !(file instanceof TFile)) return undefined;
		return normalizeFilesystemPath(path.dirname(path.join(root, file.path)));
	}

	/** Resolve the value stored in settings to the absolute path Codex needs. */
	resolve(value: string): string {
		const trimmed = value.trim();
		if (!trimmed) return this.getVaultRoot() ?? '';
		const root = this.getVaultRoot();
		const pathApi = process.platform === 'win32' ? path.win32 : path;
		const normalized = normalizeFilesystemPath(trimmed);
		if (pathApi.isAbsolute(normalized) || !root) return normalized;
		return normalizeFilesystemPath(pathApi.join(root, trimmed));
	}

	/** Store paths inside the vault portably; external paths remain local overrides. */
	toStoredPath(value: string): string {
		const absolute = this.resolve(value);
		const root = this.getVaultRoot();
		if (!root || !absolute) return value.trim();
		const pathApi = process.platform === 'win32' ? path.win32 : path;
		const relative = pathApi.relative(root, absolute);
		const isOutside = relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative);
		return isOutside ? absolute : (relative || '.').split(pathApi.sep).join('/');
	}

	async validate(value: string): Promise<string> {
		return validateWorkingDirectory(this.resolve(value));
	}
}
