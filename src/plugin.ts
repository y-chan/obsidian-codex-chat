import { Notice, Plugin } from 'obsidian';
import { normalizeSettings, CodexHistorySettingTab, CodexHistorySettings } from './settings';
import { Logger } from './utils/logger';
import { WorkingDirectoryService } from './services/WorkingDirectoryService';
import { CodexHistoryService } from './services/CodexHistoryService';
import { CodexAppServerService } from './services/CodexAppServerService';
import { LocalCodexHistoryProvider } from './providers/LocalCodexHistoryProvider';
import { CodexHistoryView, CODEX_CHAT_ICON, CODEX_HISTORY_VIEW_TYPE } from './views/CodexHistoryView';
import type { HistoryLoadError } from './types/codex';

export default class CodexHistoryPlugin extends Plugin {
	settings!: CodexHistorySettings;
	private workingDirectoryService!: WorkingDirectoryService;
	private historyProvider!: LocalCodexHistoryProvider;
	private historyService!: CodexHistoryService;
	private chatService!: CodexAppServerService;

	async onload(): Promise<void> {
		this.settings = normalizeSettings((await this.loadData()) as Partial<CodexHistorySettings>);
		this.workingDirectoryService = new WorkingDirectoryService(this.app);
		const storedWorkingDirectory = this.workingDirectoryService.toStoredPath(this.settings.defaultWorkingDirectory);
		if (storedWorkingDirectory !== this.settings.defaultWorkingDirectory) {
			this.settings.defaultWorkingDirectory = storedWorkingDirectory;
			await this.saveData(this.settings);
		}
		this.historyProvider = new LocalCodexHistoryProvider({ historyPath: this.settings.historyPath, autoDiscoverHistory: this.settings.autoDiscoverHistory, maxSessions: this.settings.maxSessions, maxMessagesPerSession: this.settings.maxMessagesPerSession, logger: new Logger(this.settings.debugLogging) });
		this.historyService = new CodexHistoryService(this.historyProvider);
		this.chatService = new CodexAppServerService(this.settings.model, () => this.settings.historyPath);
		this.registerView(CODEX_HISTORY_VIEW_TYPE, (leaf) => new CodexHistoryView(leaf, this.historyService, this.workingDirectoryService, this.chatService, this));
		this.addSettingTab(new CodexHistorySettingTab(this.app, this));
		this.addRibbonIcon(CODEX_CHAT_ICON, 'Open Codex Chat', () => void this.openHistoryView());
		this.addCommand({ id: 'open-codex-history', name: 'Open Codex Chat', callback: () => void this.openHistoryView() });
		this.addCommand({ id: 'reload-codex-history', name: 'Reload Codex sessions', callback: () => void this.reloadHistory() });
		this.addCommand({ id: 'send-current-codex-message', name: 'Send current Codex message', hotkeys: [{ modifiers: ['Mod'], key: 'Enter' }], callback: () => document.dispatchEvent(new Event('codex-history-send')) });
		this.addCommand({ id: 'use-vault-root-as-codex-working-directory', name: 'Use vault root as Codex working directory', callback: () => void this.useWorkingDirectory(this.workingDirectoryService.getVaultRoot()) });
		this.addCommand({ id: 'use-current-file-directory-as-codex-working-directory', name: 'Use current file directory as Codex working directory', callback: () => void this.useWorkingDirectory(this.workingDirectoryService.getCurrentFileDirectory()) });
	}

	onunload(): void {
		this.chatService?.dispose();
	}

	async openHistoryView(): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(CODEX_HISTORY_VIEW_TYPE)[0];
		if (!leaf) leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		await leaf.setViewState({ type: CODEX_HISTORY_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	async reloadHistory(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(CODEX_HISTORY_VIEW_TYPE);
		if (leaves.length === 0) { await this.openHistoryView(); return; }
		for (const leaf of leaves) if (leaf.view instanceof CodexHistoryView) await leaf.view.reload();
	}

	async useWorkingDirectory(value: string | undefined): Promise<void> {
		if (!value) { new Notice('The requested local directory is unavailable.'); return; }
		try {
			const directory = await this.workingDirectoryService.validate(value);
			this.settings.defaultWorkingDirectory = this.workingDirectoryService.toStoredPath(directory);
			this.settings.useVaultRootAsDefault = false;
			await this.saveSettings();
			for (const leaf of this.app.workspace.getLeavesOfType(CODEX_HISTORY_VIEW_TYPE)) if (leaf.view instanceof CodexHistoryView) await leaf.view.setWorkingDirectory(directory);
		} catch (error) { new Notice(error instanceof Error ? error.message : String(error)); }
	}

	getInitialWorkingDirectory(): string | undefined {
		if (!this.settings.useVaultRootAsDefault && this.settings.defaultWorkingDirectory) return this.workingDirectoryService.resolve(this.settings.defaultWorkingDirectory);
		return this.workingDirectoryService.getVaultRoot() ?? (this.settings.defaultWorkingDirectory || undefined);
	}

	toStoredWorkingDirectory(value: string): string {
		return this.workingDirectoryService.toStoredPath(value);
	}

	getHistoryErrors(): HistoryLoadError[] { return this.historyProvider.getErrors(); }

	async saveSettings(): Promise<void> {
		this.settings = normalizeSettings(this.settings);
		this.chatService?.setModel(this.settings.model);
		this.historyProvider?.updateOptions({ historyPath: this.settings.historyPath, autoDiscoverHistory: this.settings.autoDiscoverHistory, maxSessions: this.settings.maxSessions, maxMessagesPerSession: this.settings.maxMessagesPerSession, logger: new Logger(this.settings.debugLogging) });
		await this.saveData(this.settings);
	}
}
