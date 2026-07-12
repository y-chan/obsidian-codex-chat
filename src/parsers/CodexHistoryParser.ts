import path from 'node:path';
import type { CodexMessage, CodexMessageRole, CodexSession, CodexSessionSummary } from '../types/codex';

export interface ParsedHistory {
	session: CodexSession;
	threadSource?: string;
	parentThreadId?: string;
	agentNickname?: string;
	workingDirectory?: string;
	parseErrors: number;
}

type JsonRecord = Record<string, unknown>;

export function parseCodexHistoryText(text: string, sourcePath: string, fallbackUpdatedAt?: string): ParsedHistory {
	const trimmed = text.trim();
	let records: unknown[] = [];
	let parseErrors = 0;
	if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
		try {
			const value: unknown = JSON.parse(trimmed);
			if (isRecord(value) && Array.isArray(value.messages)) {
				const nestedMessages = value.messages as unknown[];
				records = [{ ...value, messages: undefined }, ...nestedMessages];
			} else {
				records = Array.isArray(value) ? value : [value];
			}
		} catch {
			// A JSONL file is parsed line-by-line below; a malformed JSON object is retained as an empty session.
			parseErrors = 0;
		}
	}
	if (records.length === 0 && trimmed.length > 0) {
		records = trimmed.split(/\r?\n/).flatMap((line) => {
			if (!line.trim()) return [];
			try {
				return [JSON.parse(line) as unknown];
			} catch {
				parseErrors += 1;
				return [];
			}
		});
	}

	const normalizedRecords = records.filter(isRecord);
	const meta = findSessionMeta(normalizedRecords) ?? normalizedRecords.find((record) => Boolean(firstString(record.id, record.session_id, record.conversation_id)));
	const id = firstString(meta?.id, meta?.session_id, meta?.conversation_id) ?? fileId(sourcePath);
	const threadSource = firstString(meta?.thread_source);
	const parentThreadId = firstString(meta?.parent_thread_id);
	const agentNickname = firstString(meta?.agent_nickname);
	const messages: CodexMessage[] = [];
	let firstTimestamp: string | undefined;
	let lastTimestamp: string | undefined;
	let workingDirectory = firstString(meta?.cwd, meta?.working_directory);
	let title = firstString(meta?.thread_name, meta?.title, meta?.name);

	for (const [index, record] of normalizedRecords.entries()) {
		const timestamp = firstString(record.timestamp, record.created_at, record.createdAt);
		if (timestamp && !firstTimestamp) firstTimestamp = timestamp;
		if (timestamp) lastTimestamp = timestamp;
		const payload = isRecord(record.payload) ? record.payload : record;
		if (!workingDirectory) workingDirectory = firstString(payload.cwd, payload.working_directory, record.cwd);
		const eventType = firstString(record.type, payload.type);
		if (!title && eventType !== 'response_item' && eventType !== 'responseItem') title = firstString(payload.thread_name, payload.title, record.thread_name);
		if (isSessionMeta(record, payload)) continue;

		const message = recordToMessage(record, payload, timestamp, index);
		if (message && isDisplayableMessage(message, record, payload)) messages.push(message);
	}

	const updatedAt = lastTimestamp ?? fallbackUpdatedAt;
	const displayMessages = mergeToolMessages(deduplicateMessages(messages));
	const derivedTitle = titleFromMessages(displayMessages);
	const normalizedTitle = normalizeTitle(title) ?? derivedTitle;
	const previewSource = displayMessages.find((message) => message.role === 'user') ?? displayMessages[0];
	const session: CodexSession = {
		id,
		...(normalizedTitle ? { title: normalizedTitle } : {}),
		...(firstTimestamp ? { createdAt: firstTimestamp } : {}),
		...(updatedAt ? { updatedAt } : {}),
		...(previewSource?.markdown ? { preview: previewText(previewSource.markdown) } : {}),
		messages: displayMessages,
	};
	return {
		session,
		...(threadSource ? { threadSource } : {}),
		...(parentThreadId ? { parentThreadId } : {}),
		...(agentNickname ? { agentNickname } : {}),
		...(workingDirectory ? { workingDirectory } : {}),
		parseErrors,
	};
}

export function sortSessionSummaries(sessions: CodexSessionSummary[]): CodexSessionSummary[] {
	return [...sessions].sort((left, right) => {
		const leftTime = Date.parse(left.updatedAt ?? left.createdAt ?? '') || 0;
		const rightTime = Date.parse(right.updatedAt ?? right.createdAt ?? '') || 0;
		return rightTime - leftTime || left.id.localeCompare(right.id);
	});
}

export function filterSessionSummaries(sessions: CodexSessionSummary[], query: string): CodexSessionSummary[] {
	const normalizedQuery = query.trim().toLocaleLowerCase();
	if (!normalizedQuery) return sessions;
	return sessions.filter((session) => [session.title, session.preview, session.id].filter(Boolean).join(' ').toLocaleLowerCase().includes(normalizedQuery));
}

function findSessionMeta(records: JsonRecord[]): JsonRecord | undefined {
	for (const record of records) {
		const payload = isRecord(record.payload) ? record.payload : record;
		if (isSessionMeta(record, payload)) return payload;
	}
	return undefined;
}

function isSessionMeta(record: JsonRecord, payload: JsonRecord): boolean {
	return record.type === 'session_meta' || payload.type === 'session_meta' || payload.type === 'sessionMeta';
}

function recordToMessage(record: JsonRecord, payload: JsonRecord, timestamp: string | undefined, index: number): CodexMessage | undefined {
	const eventType = firstString(record.type, payload.type);
	const role = roleFor(record, payload, eventType);
	let markdown = '';
	if (eventType === 'event_msg') {
		const payloadType = firstString(payload.type);
		if (payloadType === 'user_message' || payloadType === 'agent_message') markdown = extractText(payload.message ?? payload.text ?? payload.content);
		else if (payloadType === 'error') markdown = extractText(payload.message ?? payload.error);
	} else if (eventType === 'response_item' || eventType === 'responseItem') {
		markdown = responseItemText(payload);
	} else {
		markdown = extractText(payload.markdown ?? payload.text ?? payload.message ?? payload.content ?? record.message);
	}

	if (!markdown && role === 'unknown' && eventType && !ignoredEventTypes.has(eventType)) markdown = fencedJson(payload);
	if (!markdown) return undefined;
	const callId = firstString(record.call_id, payload.call_id);
	const payloadType = firstString(payload.type);
	const toolName = firstString(payload.name);
	const metadata: Record<string, unknown> = {
		 eventType,
		...(payloadType ? { payloadType } : {}),
		...(callId ? { callId } : {}),
		...(toolName ? { toolName: normalizedToolName(toolName, payload) } : {}),
	};
	const subagentId = extractSubagentId(markdown);
	if (subagentId) metadata.subagentId = subagentId;
	return {
		id: firstString(record.id, payload.id) ?? `message-${index + 1}`,
		role,
		markdown,
		...(timestamp ? { createdAt: timestamp } : {}),
		metadata,
	};
}

function isDisplayableMessage(message: CodexMessage, record: JsonRecord, payload: JsonRecord): boolean {
	if (message.role === 'system' || message.role === 'unknown') return false;
	const eventType = firstString(record.type, payload.type);
	if (message.role === 'user' && (eventType === 'response_item' || eventType === 'responseItem')) return false;
	if (eventType === 'response_item' || eventType === 'responseItem') {
		if (looksLikeSystemPrompt(message.markdown)) return false;
	}
	return true;
}

function roleFor(record: JsonRecord, payload: JsonRecord, eventType: string | undefined): CodexMessageRole {
	const rawRole = firstString(payload.role, record.role);
	if (rawRole === 'user') return 'user';
	if (rawRole === 'assistant' || rawRole === 'developer') return rawRole === 'developer' ? 'system' : 'assistant';
	if (rawRole === 'system') return 'system';
	if (rawRole === 'tool' || rawRole === 'function') return 'tool';
	if (eventType === 'event_msg') {
		const payloadType = firstString(payload.type);
		if (payloadType === 'user_message') return 'user';
		if (payloadType === 'agent_message') return 'assistant';
		if (payloadType === 'error') return 'system';
	}
	if (eventType === 'response_item') {
		if (['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(firstString(payload.type) ?? '')) return 'tool';
	}
	return 'unknown';
}

function responseItemText(payload: JsonRecord): string {
	const type = firstString(payload.type);
	if (type === 'function_call') return formatToolCall(firstString(payload.name), payload.arguments);
	if (type === 'custom_tool_call') return formatToolCall(firstString(payload.name), payload.input);
	if (type === 'function_call_output' || type === 'custom_tool_call_output') return extractText(payload.output ?? payload.content ?? payload.text);
	return extractText(payload.content ?? payload.text ?? payload.message);
}

function formatToolCall(name: string | undefined, rawValue: unknown): string {
	const raw = typeof rawValue === 'string' ? rawValue : stringifyValue(rawValue);
	const parsed = parseJsonRecord(raw);
	const patch = name === 'apply_patch' ? (parsed?.input ?? parsed?.arguments ?? raw) : undefined;
	if (typeof patch === 'string' && patch.includes('*** Begin Patch')) return fencedCode('diff', patch);

	const command = typeof parsed?.command === 'string' ? parsed.command : name === 'exec' ? extractStringProperty(raw, 'command') : undefined;
	if (command) return fencedCode('sh', command);
	if (typeof parsed?.message === 'string') return parsed.message;
	if (typeof parsed?.input === 'string') return parsed.input;
	if (name === 'apply_patch' && raw) return fencedCode('diff', raw);
	return raw;
}

function parseJsonRecord(value: string): JsonRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

function extractStringProperty(value: string, key: string): string | undefined {
	const match = new RegExp(`${key}\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, 's').exec(value);
	if (!match?.[1]) return undefined;
	try {
		return JSON.parse(match[1]) as string;
	} catch {
		return undefined;
	}
}

function stringifyValue(value: unknown): string {
	if (value === undefined) return '';
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return 'Unserializable tool input';
	}
}

function extractText(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n\n');
	if (isRecord(value)) {
		for (const key of ['text', 'value', 'input_text', 'output_text', 'message']) {
			if (value[key] !== undefined) {
				const text = extractText(value[key]);
				if (text) return text;
			}
		}
	}
	return '';
}

function fencedJson(value: unknown): string {
	try {
		return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
	} catch {
		return String(value);
	}
}

function fencedCode(language: string, value: string): string {
	return `\`\`\`${language}\n${value}\n\`\`\``;
}

function titleFromMessages(messages: CodexMessage[]): string | undefined {
	const source = messages.find((message) => message.role === 'user');
	if (!source) return undefined;
	return normalizeTitle(source.markdown);
}

function deduplicateMessages(messages: CodexMessage[]): CodexMessage[] {
	const result: CodexMessage[] = [];
	let previousKey: string | undefined;
	for (const message of messages) {
		const key = `${message.role}:${normalizeMessageText(message.markdown)}`;
		if (key === previousKey) continue;
		result.push(message);
		previousKey = key;
	}
	return result;
}

function mergeToolMessages(messages: CodexMessage[]): CodexMessage[] {
	const result: CodexMessage[] = [];
	const byCallId = new Map<string, CodexMessage>();
	for (const message of messages) {
		if (message.role !== 'tool') {
			result.push(message);
			continue;
		}
		const callId = metadataString(message, 'callId');
		if (!callId) {
			result.push(message);
			continue;
		}
		const existing = byCallId.get(callId);
		if (!existing) {
			byCallId.set(callId, message);
			result.push(message);
			continue;
		}
		const eventType = metadataString(message, 'payloadType') ?? metadataString(message, 'eventType') ?? '';
		const isOutput = eventType.endsWith('_output');
		const section = isOutput ? `**Result**\n\n${message.markdown}` : message.markdown;
		if (!normalizeMessageText(existing.markdown).includes(normalizeMessageText(message.markdown))) {
			existing.markdown = isOutput ? `${existing.markdown}\n\n${section}` : `${section}\n\n${existing.markdown}`;
		}
		existing.metadata = { ...existing.metadata, ...message.metadata };
	}
	return result;
}

function normalizedToolName(name: string, payload: JsonRecord): string {
	const input = firstString(payload.input, payload.arguments) ?? '';
	if (/spawn_agent/i.test(name) || (name === 'exec' && input.includes('multi_agent_v1__spawn_agent'))) return 'subagent spawn';
	if (name === 'exec' && /guardian|approve|approval/i.test(input)) return 'guardian approval';
	if (name === 'exec' && input.includes('shell_command')) return 'shell_command';
	return name;
}

function extractSubagentId(value: string): string | undefined {
	return /["'](?:agent_path|agent_id)["']\s*:\s*["']([^"']+)["']/.exec(value)?.[1];
}

function metadataString(message: CodexMessage, key: string): string | undefined {
	const value = message.metadata?.[key];
	return typeof value === 'string' ? value : undefined;
}

function normalizeMessageText(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function normalizeTitle(value: string | undefined): string | undefined {
	if (!value || looksLikeSystemPrompt(value)) return undefined;
	const plainText = value
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/[*_`~>]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!plainText) return undefined;
	return plainText.length > 72 ? `${plainText.slice(0, 69).trimEnd()}...` : plainText;
}

function looksLikeSystemPrompt(value: string): boolean {
	return /(^|\n)\s*#\s*AGENTS\.md\b/i.test(value)
		|| /<environment_context>|<permissions instructions>|<skills_instructions>|<apps_instructions>/i.test(value)
		|| /\bYou are Codex\b/i.test(value);
}

function previewText(value: string): string {
	return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function fileId(sourcePath: string): string {
	return path.basename(sourcePath).replace(/\.(jsonl?|ndjson|gz)$/i, '') || sourcePath;
}

function firstString(...values: unknown[]): string | undefined {
	return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim();
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ignoredEventTypes = new Set(['token_count', 'turn_context', 'task_started', 'task_complete', 'turn_started', 'turn_complete']);
