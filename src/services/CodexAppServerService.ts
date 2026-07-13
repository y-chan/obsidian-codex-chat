import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCodexHistoryText } from '../parsers/CodexHistoryParser';
import { codexHomeCandidates, normalizeFilesystemPath } from '../utils/paths';
import { resolveCodexPath } from './CodexChatService';

export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';
export type ThinkingEffort = '' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export interface AppServerSendOptions { workingDirectory: string; threadId?: string; prompt: string; images?: string[]; signal?: AbortSignal; }
export interface AppServerResult { threadId: string; finalResponse: string; turnStatus: 'completed' | 'interrupted'; }
export interface AppServerModel { id: string; displayName?: string; }
export interface UsageWindow { remainingPercent: number; resetsAt?: number; }
export interface UsageStatus { accountName?: string; plan?: string; contextRemainingPercent?: number; fiveHour?: UsageWindow; weekly?: UsageWindow; }
export interface AppServerUpdate { kind: 'status' | 'assistant' | 'tool' | 'approval' | 'usage'; id?: string; text: string; completed?: boolean; toolName?: string; requestId?: number; approvalKind?: 'command' | 'fileChange'; command?: string; decision?: (decision: ApprovalDecision) => void; usage?: UsageStatus; }
interface Rpc { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string }; }

export class CodexAppServerService {
	private process?: ChildProcessWithoutNullStreams;
	private ready?: Promise<void>;
	private nextId = 1;
	private buffer = '';
	private readonly pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }>();
	private active?: { threadId: string; turnId: string; response: string; resolve: (result: { response: string; status: 'completed' | 'interrupted' }) => void; reject: (error: Error) => void };
	private readonly earlyTurnEvents: Array<{ method: string; params: Record<string, unknown> }> = [];
	private readonly interruptedTurnIds = new Set<string>();
	private update?: (value: AppServerUpdate) => void;
	private readonly assistantText = new Map<string, string>();
	private readonly toolText = new Map<string, string>();
	private model?: string;
	private effort?: Exclude<ThinkingEffort, ''>;
	private sendInProgress = false;
	private currentThreadId?: string;
	private currentTurn?: { threadId: string; turnId: string };
	private contextRemainingPercent?: number;

	constructor(model?: string, private readonly historyPath?: () => string) { this.model = model?.trim() || undefined; }
	setModel(model: string): void { this.model = model.trim() || undefined; }
	getModel(): string { return this.model ?? ''; }
	setThinkingEffort(effort: ThinkingEffort): void { this.effort = isThinkingEffort(effort) ? effort : undefined; }
	getThinkingEffort(): ThinkingEffort { return this.effort ?? ''; }
	async listModels(): Promise<AppServerModel[]> {
		await this.start();
		const result = await this.request('model/list', { includeHidden: false });
		const data = Array.isArray(result.data) ? result.data : [];
		return data.flatMap((item) => {
			if (!item || typeof item !== 'object') return [];
			const model = item as Record<string, unknown>;
			const id = stringValue(model.id) ?? stringValue(model.model);
			return id ? [{ id, displayName: stringValue(model.displayName) }] : [];
		});
	}
	async getUsageStatus(): Promise<UsageStatus> {
		await this.start();
		const accountResult = await this.request('account/read', { refreshToken: false });
		const account = asRecord(accountResult.account);
		const usage: UsageStatus = {
			accountName: stringValue(account?.email),
			plan: stringValue(account?.planType),
		};
		try {
			const rateResult = await this.request('account/rateLimits/read', {});
			const limits = asRecord(rateResult.rateLimits);
			const primary = toUsageWindow(limits?.primary);
			const secondary = toUsageWindow(limits?.secondary);
			if (primary && isFiveHourWindow(limits?.primary)) usage.fiveHour = primary;
			else if (primary) usage.weekly = primary;
			if (secondary && isFiveHourWindow(limits?.secondary)) usage.fiveHour = secondary;
			else if (secondary) usage.weekly = secondary;
		} catch {
			// API-key and local-model accounts may not expose ChatGPT rate limits.
		}
		return usage;
	}
	async getThreadContextUsage(threadId: string, workingDirectory: string): Promise<number | undefined> {
		if (this.sendInProgress || !threadId || !workingDirectory) return undefined;
		await this.start();
		this.contextRemainingPercent = undefined;
		const result = await this.request('thread/resume', { threadId, cwd: workingDirectory });
		const directUsage = asRecord(result.tokenUsage) ?? asRecord(asRecord(result.thread)?.tokenUsage);
		const directContext = contextRemainingPercent(directUsage);
		if (directContext !== undefined) return directContext;
		await new Promise((resolve) => window.setTimeout(resolve, 100));
		return this.contextRemainingPercent;
	}

	async send(options: AppServerSendOptions, update?: (value: AppServerUpdate) => void): Promise<AppServerResult> {
		if (this.sendInProgress) throw new Error('Another Codex turn is already running.');
		this.sendInProgress = true;
		try { await this.start(); } catch (error) { this.sendInProgress = false; throw error; }
		this.update = update; this.assistantText.clear(); this.toolText.clear();
		let threadResult: Record<string, unknown>;
		try { threadResult = options.threadId ? await this.request('thread/resume', { threadId: options.threadId, cwd: options.workingDirectory }) : await this.request('thread/start', { cwd: options.workingDirectory, model: this.model, effort: this.effort }); } catch (error) { this.sendInProgress = false; throw error; }
		const threadId = stringValue((threadResult.thread as Record<string, unknown> | undefined)?.id) ?? options.threadId;
		if (!threadId) { this.sendInProgress = false; throw new Error('app-server did not return a thread id.'); }
		this.currentThreadId = threadId;
		const input = [{ type: 'text', text: options.prompt }, ...(options.images ?? []).map((image) => ({ type: 'localImage', path: image }))];
		let turnResult: Record<string, unknown>;
		// Do not override approval settings here. Let app-server inherit the
		// user's Codex config.toml, including approvals_reviewer=auto_review
		// (Guardian). Sending approvalsReviewer: 'user' would force every
		// approval request back to this plugin's UI.
		try { turnResult = await this.request('turn/start', { threadId, input, cwd: options.workingDirectory, model: this.model, effort: this.effort }); } catch (error) { this.sendInProgress = false; throw error; }
		const turnId = stringValue((turnResult.turn as Record<string, unknown> | undefined)?.id);
		if (!turnId) { this.sendInProgress = false; throw new Error('app-server did not return a turn id.'); }
		this.currentTurn = { threadId, turnId };
		update?.({ kind: 'status', text: 'Working…' });
		try {
			const result = await this.waitForTurn(threadId, turnId, options.signal);
			return { threadId, finalResponse: result.response, turnStatus: result.status };
		}
		finally { this.active = undefined; this.currentTurn = undefined; this.currentThreadId = undefined; this.update = undefined; this.earlyTurnEvents.length = 0; this.sendInProgress = false; }
	}
	async steer(options: AppServerSendOptions): Promise<void> {
		const turn = this.currentTurn;
		if (!turn) throw new Error('There is no active Codex turn to steer.');
		const input = [{ type: 'text', text: options.prompt }, ...(options.images ?? []).map((image) => ({ type: 'localImage', path: image }))];
		await this.request('turn/steer', { threadId: turn.threadId, expectedTurnId: turn.turnId, input });
	}

	stop(): void { if (this.active) void this.request('turn/interrupt', { threadId: this.active.threadId, turnId: this.active.turnId }).catch(() => undefined); }
	dispose(): void { this.active?.reject(new Error('Codex app-server stopped.')); this.rejectPending(new Error('Codex app-server stopped.')); this.interruptedTurnIds.clear(); this.currentTurn = undefined; this.process?.kill(); this.process = undefined; this.ready = undefined; }
	respond(requestId: number, decision: ApprovalDecision): void {
		this.write({ id: requestId, result: { decision } });
		this.update?.({ kind: 'status', text: `Approval response sent: ${decision} (request ${requestId}).` });
	}

	private async start(): Promise<void> {
		if (this.ready) return this.ready;
		this.ready = new Promise<void>((resolve, reject) => {
			const child = spawn(resolveCodexPath(), ['app-server', '--stdio'], { env: process.env }); this.process = child;
			child.stdout.on('data', (chunk: Buffer) => this.read(chunk.toString('utf8')));
			child.stderr.on('data', (chunk: Buffer) => { const text = chunk.toString('utf8').trim(); if (text) this.update?.({ kind: 'status', text }); });
			child.once('error', (error) => { this.ready = undefined; this.rejectPending(error); reject(error); });
			child.once('exit', (code) => { const error = new Error(`Codex app-server exited with code ${code ?? 'unknown'}.`); this.ready = undefined; this.rejectPending(error); this.active?.reject(error); });
			void this.request('initialize', { clientInfo: { name: 'obsidian-codex-chat', title: 'Obsidian Codex Chat', version: '1.0.0' } }).then(() => { this.write({ method: 'initialized', params: {} }); resolve(); }).catch(reject);
		});
		return this.ready;
	}
	private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> { const id = this.nextId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.write({ id, method, params }); }); }
	private write(message: Rpc): void { if (!this.process?.stdin.writable) throw new Error('app-server stdin is unavailable.'); this.process.stdin.write(`${JSON.stringify(message)}\n`); }
	private read(chunk: string): void { this.buffer += chunk; const lines = this.buffer.split(/\r?\n/); this.buffer = lines.pop() ?? ''; for (const line of lines) { if (!line.trim()) continue; try { this.handle(JSON.parse(line) as Rpc); } catch (error) { this.update?.({ kind: 'status', text: `Invalid app-server event: ${String(error)}` }); } } }
	private handle(message: Rpc): void { if (message.id !== undefined && !message.method) { const request = this.pending.get(message.id); if (!request) return; this.pending.delete(message.id); if (message.error) request.reject(new Error(message.error.message ?? 'app-server request failed.')); else request.resolve(message.result ?? {}); return; } if (message.method && message.id !== undefined) { this.serverRequest(message.method, message.id, message.params ?? {}); return; } if (message.method) this.notification(message.method, message.params ?? {}); }
	private serverRequest(method: string, id: number, params: Record<string, unknown>): void { if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') { const approvalKind = method.includes('fileChange') ? 'fileChange' : 'command'; const command = stringValue(params.command); this.update?.({ kind: 'approval', id: stringValue(params.itemId), requestId: id, approvalKind, command, text: stringValue(params.reason) ?? (command ? `$ ${command}` : 'Codex requests approval.'), decision: (decision) => this.respond(id, decision) }); return; } this.write({ id, result: { decision: 'cancel' } }); }
	private notification(method: string, params: Record<string, unknown>): void {
		const turnId = turnEventId(method, params);
		if (turnId && this.interruptedTurnIds.has(turnId)) {
			if (method === 'turn/completed') this.interruptedTurnIds.delete(turnId);
			return;
		}
		if (!this.active && isTurnEvent(method)) {
			this.earlyTurnEvents.push({ method, params });
			return;
		}
		if (method === 'serverRequest/resolved') { this.update?.({ kind: 'status', text: `Approval request resolved: ${displayValue(params.requestId) ?? 'unknown'}.` }); return; }
		if (method === 'turn/completed') {
			const turn = params.turn as Record<string, unknown> | undefined;
			this.emitContextUsage(turn?.usage);
			const status = stringValue(turn?.status);
			this.update?.({ kind: 'status', text: `Turn completed: ${status ?? 'unknown'}.` });
			if (status === 'failed') this.active?.reject(new Error(stringValue((turn?.error as Record<string, unknown> | undefined)?.message) ?? 'Codex turn failed.'));
			else if (status === 'interrupted') this.active?.resolve({ response: this.active.response, status: 'interrupted' });
			else this.active?.resolve({ response: this.active.response, status: 'completed' });
			return;
		}
		if (method === 'turn/started') { this.update?.({ kind: 'status', text: 'Working…' }); return; }
		if (method === 'error') { this.active?.reject(new Error(stringValue((params.error as Record<string, unknown> | undefined)?.message) ?? 'app-server error.')); return; }
		if (method === 'item/agentMessage/delta') { const id = stringValue(params.itemId) ?? 'assistant'; const text = (this.assistantText.get(id) ?? '') + (stringValue(params.delta) ?? ''); this.assistantText.set(id, text); if (this.active) this.active.response = text; this.update?.({ kind: 'assistant', id, text }); return; }
		if (method === 'item/commandExecution/outputDelta') { const id = stringValue(params.itemId) ?? 'command'; const text = (this.toolText.get(id) ?? '') + (stringValue(params.delta) ?? ''); this.toolText.set(id, text); this.update?.({ kind: 'tool', id, toolName: 'shell command', text }); return; }
		if (method === 'item/started' || method === 'item/completed') { const item = params.item as Record<string, unknown> | undefined; if (item) this.item(item, method === 'item/completed'); return; }
		if (method === 'item/autoApprovalReview/started' || method === 'item/autoApprovalReview/completed') this.update?.({ kind: 'tool', id: stringValue(params.targetItemId), toolName: 'guardian approval', text: `${method.endsWith('started') ? 'Reviewing' : 'Review'}: ${stringValue((params.review as Record<string, unknown> | undefined)?.rationale) ?? 'Guardian subagent'}` });
		if (method === 'thread/tokenUsage/updated') this.emitContextUsage(params.tokenUsage);
	}
	private emitContextUsage(value: unknown): void {
		const remaining = contextRemainingPercent(value);
		if (remaining === undefined) return;
		this.contextRemainingPercent = remaining;
		this.update?.({ kind: 'usage', text: '', usage: { contextRemainingPercent: remaining } });
	}
	private item(item: Record<string, unknown>, completed: boolean): void {
		const id = stringValue(item.id);
		const type = stringValue(item.type);
		if (!id || !type) return;
		if (type === 'agentMessage') this.update?.({ kind: 'assistant', id, text: stringValue(item.text) ?? this.assistantText.get(id) ?? '', completed });
		else if (type === 'commandExecution') this.update?.({ kind: 'tool', id, toolName: 'shell command', text: `$ ${stringValue(item.command) ?? 'Command'}\n\n${stringValue(item.aggregatedOutput) ?? ''}`, completed });
		else if (type === 'fileChange') {
			const changes = Array.isArray(item.changes) ? item.changes as Array<Record<string, unknown>> : [];
			const notify = this.update;
			const fallback = changes.map((change) => `${stringValue(change.kind) ?? 'update'}: ${stringValue(change.path) ?? 'unknown file'}`).join('\n');
			notify?.({ kind: 'tool', id, toolName: 'apply_patch', text: fallback, completed });
			if (completed && this.currentThreadId) void this.findPatchMarkdown(this.currentThreadId).then((markdown) => {
				if (markdown) notify?.({ kind: 'tool', id, toolName: 'apply_patch', text: markdown, completed: true });
			}).catch(() => undefined);
		}
	}

	private async findPatchMarkdown(threadId: string): Promise<string | undefined> {
		for (const delay of [0, 150, 350, 700]) {
			if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay));
			const files = await this.historyFiles();
			for (const sourcePath of files) {
				try {
					const text = await fs.readFile(sourcePath, 'utf8');
					if (!text.includes(threadId)) continue;
					const parsed = parseCodexHistoryText(text, sourcePath);
					if (parsed.session.id !== threadId) continue;
					const patch = [...parsed.session.messages].reverse().find((message) => message.role === 'tool' && message.markdown.includes('```diff'));
					if (patch) return patch.markdown;
				} catch {
					// The rollout may still be being written. Try the next candidate.
				}
			}
		}
		return undefined;
	}

	private async historyFiles(): Promise<string[]> {
		const configured = this.historyPath?.().trim();
		const roots = [...(configured ? [normalizeFilesystemPath(configured)] : []), ...codexHomeCandidates()];
		const files = new Set<string>();
		for (const root of roots) {
			try {
				const stat = await fs.stat(root);
				if (stat.isFile()) files.add(root);
				else if (stat.isDirectory()) for (const file of await this.walkHistory(root)) files.add(file);
			} catch { /* Ignore unavailable history roots. */ }
		}
		return [...files];
	}

	private async walkHistory(root: string): Promise<string[]> {
		const result: string[] = [];
		for (const entry of await fs.readdir(root, { withFileTypes: true })) {
			const entryPath = path.join(root, entry.name);
			if (entry.isDirectory()) result.push(...await this.walkHistory(entryPath));
			else if (entry.isFile() && /\.(json|jsonl|ndjson)$/i.test(entry.name)) result.push(entryPath);
		}
		return result;
	}
	private waitForTurn(threadId: string, turnId: string, signal?: AbortSignal): Promise<{ response: string; status: 'completed' | 'interrupted' }> { return new Promise((resolve, reject) => { this.active = { threadId, turnId, response: '', resolve, reject }; const bufferedEvents = this.earlyTurnEvents.splice(0); for (const event of bufferedEvents) this.notification(event.method, event.params); if (signal) { const abort = () => { this.interruptedTurnIds.add(turnId); this.earlyTurnEvents.length = 0; this.stop(); reject(new Error('Codex turn stopped.')); }; if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); } }); }
	private rejectPending(error: Error): void { for (const request of this.pending.values()) request.reject(error); this.pending.clear(); }
}

function isTurnEvent(method: string): boolean {
	return method === 'turn/started' || method === 'turn/completed' || method === 'error' || method.startsWith('item/');
}

function turnEventId(method: string, params: Record<string, unknown>): string | undefined {
	if (method === 'turn/completed' || method === 'turn/started') return stringValue((params.turn as Record<string, unknown> | undefined)?.id);
	return stringValue(params.turnId) ?? stringValue(params.turn_id);
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function asRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' ? value as Record<string, unknown> : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function clampPercent(value: number): number { return Math.max(0, Math.min(100, Math.round(value))); }
function contextRemainingPercent(value: unknown): number | undefined {
	const usage = asRecord(value);
	const directPercent = numberValue(usage?.contextPercentage) ?? numberValue(usage?.context_percentage);
	if (directPercent !== undefined) return clampPercent(100 - directPercent);
	const total = asRecord(usage?.totalTokenUsage) ?? asRecord(usage?.total_token_usage) ?? asRecord(usage?.total);
	const last = asRecord(usage?.last);
	const inputTokens = numberValue(last?.inputTokens) ?? numberValue(last?.input_tokens) ?? numberValue(total?.inputTokens) ?? numberValue(total?.input_tokens) ?? numberValue(usage?.inputTokens) ?? numberValue(usage?.input_tokens) ?? numberValue(usage?.totalTokens) ?? numberValue(usage?.total_tokens);
	const contextWindow = numberValue(usage?.modelContextWindow) ?? numberValue(usage?.model_context_window) ?? numberValue(usage?.contextWindow) ?? numberValue(usage?.context_window) ?? numberValue(usage?.maxTokens) ?? numberValue(usage?.max_tokens);
	return inputTokens === undefined || !contextWindow ? undefined : clampPercent(100 - (inputTokens / contextWindow) * 100);
}
function toUsageWindow(value: unknown): UsageWindow | undefined { const item = asRecord(value); const used = numberValue(item?.usedPercent); return used === undefined ? undefined : { remainingPercent: clampPercent(100 - used), resetsAt: numberValue(item?.resetsAt) }; }
function isFiveHourWindow(value: unknown): boolean { const duration = numberValue(asRecord(value)?.windowDurationMins); return duration !== undefined && duration <= 24 * 60; }
function displayValue(value: unknown): string | undefined { return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined; }
function isThinkingEffort(value: string): value is Exclude<ThinkingEffort, ''> { return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'; }
