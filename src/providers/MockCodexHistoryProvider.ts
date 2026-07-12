import type { CodexHistoryProvider, CodexSession, CodexSessionSummary } from '../types/codex';

export class MockCodexHistoryProvider implements CodexHistoryProvider {
	private readonly session: CodexSession = {
		id: 'mock-session-001',
		title: '匿名化されたサンプル会話',
		createdAt: '2026-01-01T09:00:00.000Z',
		updatedAt: '2026-01-01T09:05:00.000Z',
		preview: 'Markdownと数式の表示確認',
		messages: [
			{ id: 'm1', role: 'user', markdown: 'Markdownと数式を確認してください。', createdAt: '2026-01-01T09:00:00.000Z' },
			{ id: 'm2', role: 'assistant', markdown: '# 結果\n\n$$x^2 + y^2 = z^2$$\n\n```ts\nconst answer = 42;\n```', createdAt: '2026-01-01T09:01:00.000Z' },
		],
	};

	async listSessions(_options: { workingDirectory: string }): Promise<CodexSessionSummary[]> {
		return [{ id: this.session.id, title: this.session.title, createdAt: this.session.createdAt, updatedAt: this.session.updatedAt, preview: this.session.preview }];
	}

	async getSession(_options: { workingDirectory: string; sessionId: string }): Promise<CodexSession> {
		return this.session;
	}
}
