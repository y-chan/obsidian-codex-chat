export type CodexMessageRole = 'user' | 'assistant' | 'system' | 'tool' | 'unknown';

export interface CodexSessionSummary {
	id: string;
	title?: string;
	createdAt?: string;
	updatedAt?: string;
	preview?: string;
}

export interface CodexSession extends CodexSessionSummary {
	messages: CodexMessage[];
}

export interface CodexMessage {
	id: string;
	role: CodexMessageRole;
	markdown: string;
	createdAt?: string;
	metadata?: Record<string, unknown>;
}

export interface HistoryLoadError {
	source: string;
	error: string;
}

export interface CodexHistoryProvider {
	listSessions(options: { workingDirectory: string }): Promise<CodexSessionSummary[]>;
	getSession(options: { workingDirectory: string; sessionId: string }): Promise<CodexSession>;
}
