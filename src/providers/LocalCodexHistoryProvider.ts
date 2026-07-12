import fs from 'node:fs/promises';
import path from 'node:path';
import type { CodexHistoryProvider, CodexMessage, CodexSession, CodexSessionSummary, HistoryLoadError } from '../types/codex';
import { parseCodexHistoryText, sortSessionSummaries } from '../parsers/CodexHistoryParser';
import { codexHomeCandidates, normalizeFilesystemPath, pathsEqual } from '../utils/paths';
import { Logger } from '../utils/logger';

export interface LocalCodexHistoryProviderOptions {
	historyPath: string;
	autoDiscoverHistory: boolean;
	maxSessions: number;
	maxMessagesPerSession: number;
	logger: Logger;
}

interface IndexedFile {
	path: string;
	session: CodexSessionSummary;
	threadSource?: string;
	parentThreadId?: string;
	agentNickname?: string;
	workingDirectory?: string;
}

const SUMMARY_READ_BYTES = 512 * 1024;

export class LocalCodexHistoryProvider implements CodexHistoryProvider {
	private readonly files = new Map<string, IndexedFile>();
	private subagentFiles: IndexedFile[] = [];
	private errors: HistoryLoadError[] = [];

	constructor(private options: LocalCodexHistoryProviderOptions) {}

	updateOptions(options: Partial<LocalCodexHistoryProviderOptions>): void {
		this.options = { ...this.options, ...options };
	}

	getErrors(): HistoryLoadError[] {
		return [...this.errors];
	}

	async listSessions({ workingDirectory }: { workingDirectory: string }): Promise<CodexSessionSummary[]> {
		this.options.logger.info('Starting history load', { workingDirectory });
		this.files.clear();
		this.subagentFiles = [];
		this.errors = [];
		const files = await this.discoverFiles();
		this.options.logger.info(`Reading ${files.length} candidate history file(s)`);
		for (const [index, sourcePath] of files.entries()) {
			this.options.logger.info(`Reading history file ${index + 1}/${files.length}`, sourcePath);
			try {
				const stat = await fs.stat(sourcePath);
				this.options.logger.info('History file stat complete', { sourcePath, bytes: stat.size });
				const text = this.isExplicitFile(sourcePath)
					? await fs.readFile(sourcePath, 'utf8')
					: await readFileHead(sourcePath, SUMMARY_READ_BYTES);
				this.options.logger.info('History file read complete', { sourcePath, characters: text.length });
				const parsed = parseCodexHistoryText(text, sourcePath, stat.mtime.toISOString());
				this.options.logger.info('History file parse complete', { sourcePath, messages: parsed.session.messages.length, parseErrors: parsed.parseErrors });
				if (parsed.parseErrors > 0) this.options.logger.warn(`Skipped ${parsed.parseErrors} malformed record(s)`, sourcePath);
				const indexedFile: IndexedFile = {
					path: sourcePath,
					session: parsed.session,
					...(parsed.threadSource ? { threadSource: parsed.threadSource } : {}),
					...(parsed.parentThreadId ? { parentThreadId: parsed.parentThreadId } : {}),
					...(parsed.agentNickname ? { agentNickname: parsed.agentNickname } : {}),
					...(parsed.workingDirectory ? { workingDirectory: parsed.workingDirectory } : {}),
				};
				if (parsed.threadSource === 'subagent') {
					if (parsed.parentThreadId) this.subagentFiles.push(indexedFile);
					continue;
				}
				if (parsed.threadSource !== 'user') continue;
				if (parsed.workingDirectory && !pathsEqual(parsed.workingDirectory, workingDirectory)) continue;
				if (!parsed.workingDirectory && !this.isExplicitFile(sourcePath)) continue;
				const existing = this.files.get(parsed.session.id);
				if (existing && (Date.parse(existing.session.updatedAt ?? '') || 0) > (Date.parse(parsed.session.updatedAt ?? '') || 0)) continue;
				this.files.set(parsed.session.id, indexedFile);
			} catch (error) {
				this.errors.push({ source: sourcePath, error: error instanceof Error ? error.message : String(error) });
				this.options.logger.warn('Could not read history file', { sourcePath, error });
			}
		}
		const result = sortSessionSummaries([...this.files.values()].map(({ session }) => toSummary(session)));
		this.options.logger.info('History load complete', { sessions: result.length, errors: this.errors.length });
		return result.slice(0, this.options.maxSessions);
	}

	async getSession({ workingDirectory, sessionId }: { workingDirectory: string; sessionId: string }): Promise<CodexSession> {
		let indexed = this.files.get(sessionId);
		if (!indexed) {
			await this.listSessions({ workingDirectory });
			indexed = this.files.get(sessionId);
		}
		if (!indexed) throw new Error(`Session not found: ${sessionId}`);
		if (indexed.workingDirectory && !pathsEqual(indexed.workingDirectory, workingDirectory)) throw new Error('Session does not belong to the selected working directory.');
		const parsed = await readIndexedSession(indexed);
		const childFiles = this.subagentFiles.filter((child) => child.parentThreadId === parsed.session.id);
		const childSessions = await Promise.all(childFiles.map(async (child) => ({ indexed: child, parsed: await readIndexedSession(child) })));
		const session = attachSubagentSessions(parsed.session, childSessions);
		return { ...session, messages: session.messages.slice(0, this.options.maxMessagesPerSession) };
	}

	private async discoverFiles(): Promise<string[]> {
		const roots: string[] = [];
		if (this.options.historyPath) roots.push(normalizeFilesystemPath(this.options.historyPath));
		if (this.options.autoDiscoverHistory) roots.push(...codexHomeCandidates());
		const files = new Set<string>();
		for (const root of roots) {
			try {
				this.options.logger.info('Scanning history candidate', root);
				const stat = await fs.stat(root);
				if (stat.isFile()) {
					files.add(root);
				} else if (stat.isDirectory()) {
					for (const file of await this.walk(root)) files.add(file);
				}
			} catch (error) {
				this.options.logger.debug('History candidate is unavailable', { root, error });
			}
		}
		this.options.logger.debug(`Discovered ${files.size} candidate history file(s)`, [...files]);
		return [...files];
	}

	private async walk(root: string): Promise<string[]> {
		const result: string[] = [];
		const entries = await fs.readdir(root, { withFileTypes: true });
		for (const entry of entries) {
			const entryPath = path.join(root, entry.name);
			if (entry.isDirectory()) {
				result.push(...await this.walk(entryPath));
			} else if (entry.isFile() && this.isHistoryFile(entryPath)) {
				result.push(entryPath);
			}
		}
		return result;
	}

	private isHistoryFile(value: string): boolean {
		const basename = path.basename(value);
		if (!/\.(json|jsonl|ndjson)$/i.test(basename)) return false;
		return /^rollout-/i.test(basename) || /(^|[\\/])(sessions|archived_sessions)([\\/]|$)/i.test(value);
	}

	private isExplicitFile(value: string): boolean {
		return Boolean(this.options.historyPath) && pathsEqual(value, normalizeFilesystemPath(this.options.historyPath));
	}
}

async function readIndexedSession(indexed: IndexedFile): Promise<import('../parsers/CodexHistoryParser').ParsedHistory> {
	const [text, stat] = await Promise.all([fs.readFile(indexed.path, 'utf8'), fs.stat(indexed.path)]);
	return parseCodexHistoryText(text, indexed.path, stat.mtime.toISOString());
}

function attachSubagentSessions(parent: CodexSession, children: Array<{ indexed: IndexedFile; parsed: import('../parsers/CodexHistoryParser').ParsedHistory }>): CodexSession {
	const messages = [...parent.messages];
	for (const { indexed, parsed } of children) {
		const childMessages = parsed.session.messages.filter((message) => message.role === 'user' || message.role === 'assistant');
		if (childMessages.length === 0) continue;
		const request = childMessages.find((message) => message.role === 'user');
		const responses = childMessages.filter((message) => message.role === 'assistant');
		const sections = [
			`**Subagent${indexed.agentNickname ? ` (${indexed.agentNickname})` : ''}**`,
			...(request ? [`**Request**\n\n${request.markdown}`] : []),
			...(responses.length > 0 ? [`**Response**\n\n${responses.map((message) => message.markdown).join('\n\n')}`] : []),
		];
		const childMessage: CodexMessage = {
			id: `subagent-${parsed.session.id}`,
			role: 'tool',
			markdown: sections.join('\n\n'),
			...(parsed.session.updatedAt ? { createdAt: parsed.session.updatedAt } : {}),
			metadata: { eventType: 'subagent', kind: 'subagent', threadId: parsed.session.id, ...(indexed.agentNickname ? { agentNickname: indexed.agentNickname } : {}) },
		};
		const relatedIndex = messages.findIndex((message) => message.metadata?.subagentId === parsed.session.id || message.markdown.includes(parsed.session.id));
		if (relatedIndex >= 0) messages.splice(relatedIndex + 1, 0, childMessage);
		else messages.push(childMessage);
	}
	return { ...parent, messages };
}

function toSummary(session: CodexSessionSummary): CodexSessionSummary {
	return {
		id: session.id,
		...(session.title ? { title: session.title } : {}),
		...(session.createdAt ? { createdAt: session.createdAt } : {}),
		...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
		...(session.preview ? { preview: session.preview } : {}),
	};
}

async function readFileHead(filePath: string, maxBytes: number): Promise<string> {
	const handle = await fs.open(filePath, 'r');
	try {
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
		const text = buffer.subarray(0, bytesRead).toString('utf8');
		const lastNewline = text.lastIndexOf('\n');
		return lastNewline >= 0 ? text.slice(0, lastNewline) : text;
	} finally {
		await handle.close();
	}
}
