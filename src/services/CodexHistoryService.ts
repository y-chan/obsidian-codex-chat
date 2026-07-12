import type { CodexHistoryProvider, CodexSession, CodexSessionSummary, HistoryLoadError } from '../types/codex';

export interface HistorySnapshot {
	sessions: CodexSessionSummary[];
	errors: HistoryLoadError[];
}

export class CodexHistoryService {
	private lastSnapshot: HistorySnapshot = { sessions: [], errors: [] };

	constructor(private readonly provider: CodexHistoryProvider & { getErrors?: () => HistoryLoadError[] }) {}

	async load(workingDirectory: string): Promise<HistorySnapshot> {
		const sessions = await this.provider.listSessions({ workingDirectory });
		this.lastSnapshot = { sessions, errors: this.provider.getErrors?.() ?? [] };
		return this.lastSnapshot;
	}

	async getSession(workingDirectory: string, sessionId: string): Promise<CodexSession> {
		return this.provider.getSession({ workingDirectory, sessionId });
	}

	getSnapshot(): HistorySnapshot {
		return this.lastSnapshot;
	}
}
