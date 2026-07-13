import { App, PluginSettingTab, Setting } from 'obsidian';
import type CodexHistoryPlugin from './plugin';

export interface CodexHistorySettings {
	model: string;
	defaultWorkingDirectory: string;
	useVaultRootAsDefault: boolean;
	historyPath: string;
	autoDiscoverHistory: boolean;
	debugLogging: boolean;
	maxSessions: number;
	maxMessagesPerSession: number;
}

export const DEFAULT_SETTINGS: CodexHistorySettings = {
	model: '',
	defaultWorkingDirectory: '',
	useVaultRootAsDefault: true,
	historyPath: '',
	autoDiscoverHistory: true,
	debugLogging: false,
	maxSessions: 100,
	maxMessagesPerSession: 500,
};

export function normalizeSettings(value: Partial<CodexHistorySettings>): CodexHistorySettings {
	const settings = Object.assign({}, DEFAULT_SETTINGS, value);
	return {
		...settings,
		maxSessions: clampInteger(settings.maxSessions, 1, 1000),
		maxMessagesPerSession: clampInteger(settings.maxMessagesPerSession, 1, 5000),
	};
}

function clampInteger(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export class CodexHistorySettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: CodexHistoryPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl).setName('Model').setDesc('Optional Codex model ID. Leave empty to use the CLI default.').addText((text) => text.setPlaceholder('Use CLI default').setValue(this.plugin.settings.model).onChange(async (value) => {
			this.plugin.settings.model = value.trim(); await this.plugin.saveSettings();
		}));

		new Setting(containerEl).setName('Default working directory').setDesc('Vault-relative paths are portable across Mac and Windows.').addText((text) => text.setPlaceholder('projects/my-app or an external absolute path').setValue(this.plugin.settings.defaultWorkingDirectory).onChange(async (value) => {
			this.plugin.settings.defaultWorkingDirectory = this.plugin.toStoredWorkingDirectory(value); await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName('Use vault root by default').setDesc('Use the local vault root when no explicit directory is set.').addToggle((toggle) => toggle.setValue(this.plugin.settings.useVaultRootAsDefault).onChange(async (value) => {
			this.plugin.settings.useVaultRootAsDefault = value; await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName('Codex history location').setDesc('Optional Codex home, sessions directory, or JSON/JSONL file.').addText((text) => text.setPlaceholder('Leave empty for automatic discovery').setValue(this.plugin.settings.historyPath).onChange(async (value) => {
			this.plugin.settings.historyPath = value.trim(); await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName('Enable automatic discovery').setDesc('Search CODEX_HOME and the standard user Codex home.').addToggle((toggle) => toggle.setValue(this.plugin.settings.autoDiscoverHistory).onChange(async (value) => {
			this.plugin.settings.autoDiscoverHistory = value; await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName('Enable debug logging').setDesc('Write local discovery and parser diagnostics to the developer console.').addToggle((toggle) => toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
			this.plugin.settings.debugLogging = value; await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName('Maximum sessions').setDesc('Maximum number of sessions shown after sorting by update time.').addText((text) => text.setValue(String(this.plugin.settings.maxSessions)).onChange(async (value) => {
			this.plugin.settings.maxSessions = Number(value); await this.plugin.saveSettings();
		}));
		new Setting(containerEl).setName('Maximum messages per session').setDesc('Protects the view from very large rollout files.').addText((text) => text.setValue(String(this.plugin.settings.maxMessagesPerSession)).onChange(async (value) => {
			this.plugin.settings.maxMessagesPerSession = Number(value); await this.plugin.saveSettings();
		}));
	}
}
