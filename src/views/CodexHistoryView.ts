import { ItemView, WorkspaceLeaf } from 'obsidian';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CodexHistoryService } from '../services/CodexHistoryService';
import { WorkingDirectoryService } from '../services/WorkingDirectoryService';
import { CodexChatService } from '../services/CodexChatService';
import { CodexHistoryApp, type CodexHistoryAppHandle } from '../ui/CodexHistoryApp';

export const CODEX_HISTORY_VIEW_TYPE = 'codex-history-view';

export interface CodexHistoryViewHost {
	getInitialWorkingDirectory(): string | undefined;
}

export class CodexHistoryView extends ItemView {
	private reactRoot?: Root;
	private readonly appRef: { current: CodexHistoryAppHandle | null } = { current: null };

	constructor(
		leaf: WorkspaceLeaf,
		private readonly historyService: CodexHistoryService,
		private readonly workingDirectoryService: WorkingDirectoryService,
		private readonly chatService: CodexChatService,
		private readonly host: CodexHistoryViewHost,
	) {
		super(leaf);
	}

	getViewType(): string { return CODEX_HISTORY_VIEW_TYPE; }
	getDisplayText(): string { return 'Codex history'; }

	async onOpen(): Promise<void> {
		this.reactRoot = createRoot(this.contentEl);
		this.reactRoot.render(createElement(CodexHistoryApp, {
			ref: (handle: CodexHistoryAppHandle | null) => { this.appRef.current = handle; },
			app: this.app,
			historyService: this.historyService,
				workingDirectoryService: this.workingDirectoryService,
				chatService: this.chatService,
			initialWorkingDirectory: this.host.getInitialWorkingDirectory(),
		}));
	}

	async onClose(): Promise<void> {
		this.reactRoot?.unmount();
		this.reactRoot = undefined;
		this.appRef.current = null;
		this.contentEl.empty();
	}

	async reload(): Promise<void> {
		await this.appRef.current?.reload();
	}

	async setWorkingDirectory(value: string): Promise<void> {
		await this.appRef.current?.setWorkingDirectory(value);
	}
}
