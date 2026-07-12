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

	async validate(value: string): Promise<string> {
		return validateWorkingDirectory(value);
	}
}
