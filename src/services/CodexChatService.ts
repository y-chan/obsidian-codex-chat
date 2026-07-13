import { Codex, type Input, type ThreadEvent, type ThreadItem } from '@openai/codex-sdk';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export interface SendChatOptions {
	workingDirectory: string;
	threadId?: string;
	prompt: string;
	images?: string[];
	signal?: AbortSignal;
}

export interface SendChatResult {
	threadId?: string;
	finalResponse: string;
}

export interface ChatStreamUpdate {
	kind: 'status' | 'assistant' | 'tool';
	id?: string;
	text: string;
	completed?: boolean;
	toolName?: string;
}

interface CodexThreadLike {
	id?: string;
	runStreamed(input: Input, options?: { signal?: AbortSignal }): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}

export class CodexChatService {
	private readonly codex = new Codex({ codexPathOverride: resolveCodexPath() });
	private model: string | undefined;

	constructor(model?: string) {
		this.model = model?.trim() || undefined;
	}

	setModel(model: string): void {
		this.model = model.trim() || undefined;
	}

	async send({ workingDirectory, threadId, prompt, images, signal }: SendChatOptions, onUpdate?: (update: ChatStreamUpdate) => void): Promise<SendChatResult> {
		const thread = (threadId
			? this.codex.resumeThread(threadId, { model: this.model, workingDirectory, skipGitRepoCheck: true })
			: this.codex.startThread({ model: this.model, workingDirectory, skipGitRepoCheck: true })) as unknown as CodexThreadLike;
		let finalResponse = '';
		const input: Input = images?.length
			? [{ type: 'text', text: prompt }, ...images.map((image) => ({ type: 'local_image' as const, path: image }))]
			: prompt;
		const streamed = await thread.runStreamed(input, { signal });
		for await (const event of streamed.events) {
			if (event.type === 'thread.started') {
				onUpdate?.({ kind: 'status', text: 'Codex thread started.' });
				continue;
			}
			if (event.type === 'turn.started') {
				onUpdate?.({ kind: 'status', text: 'Working…' });
				continue;
			}
			if (event.type === 'turn.completed') {
				onUpdate?.({ kind: 'status', text: 'Codex finished.' });
				continue;
			}
			if (event.type === 'turn.failed' || event.type === 'error') {
				throw new Error(event.type === 'error' ? event.message : event.error.message);
			}
			if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
				const update = toStreamUpdate(event.item, event.type === 'item.completed');
				if (update) {
					onUpdate?.(update);
					if (update.kind === 'assistant') finalResponse = update.text;
				}
			}
		}
		return {
			...(thread.id ? { threadId: thread.id } : {}),
			finalResponse,
		};
	}
}

function toStreamUpdate(item: ThreadItem, completed: boolean): ChatStreamUpdate | undefined {
	switch (item.type) {
		case 'agent_message':
			return { kind: 'assistant', id: item.id, text: item.text, completed };
		case 'command_execution': {
			const output = item.aggregated_output ? `\n\n${item.aggregated_output}` : '';
			const exitCode = item.exit_code === undefined ? '' : `\n\nExit code: ${item.exit_code}`;
			return {
				kind: 'tool',
				id: item.id,
				toolName: 'shell command',
				text: `$ ${item.command}${output}${exitCode}`,
				completed,
			};
		}
		case 'file_change':
			return {
				kind: 'tool',
				id: item.id,
				toolName: 'apply_patch',
				text: item.changes.map((change) => `${change.kind}: ${change.path}`).join('\n'),
				completed,
			};
		case 'mcp_tool_call':
			return {
				kind: 'tool',
				id: item.id,
				toolName: `${item.server}/${item.tool}`,
				text: item.error?.message ?? (item.status === 'in_progress' ? 'Running…' : 'Completed.'),
				completed,
			};
		case 'web_search':
			return { kind: 'tool', id: item.id, toolName: 'web search', text: item.query, completed };
		case 'reasoning':
			return { kind: 'status', id: item.id, text: 'Codex is reasoning…', completed };
		case 'error':
			return { kind: 'status', id: item.id, text: item.message, completed };
		default:
			return undefined;
	}
}

export function resolveCodexPath(): string {
	const explicitPath = process.env.CODEX_PATH;
	if (explicitPath && existsSync(explicitPath)) return explicitPath;
	const packagedBinary = resolvePlatformBinary();
	if (packagedBinary) return packagedBinary;

	const pathEntries = (process.env.Path ?? process.env.PATH ?? '')
		.split(path.delimiter)
		.filter(Boolean);
	const directories = [
		...pathEntries,
		process.env.PNPM_HOME,
		...(process.platform === 'darwin' ? [
			'/opt/homebrew/bin',
			'/usr/local/bin',
			path.join(os.homedir(), '.local', 'bin'),
			path.join(os.homedir(), '.npm-global', 'bin'),
		] : []),
		process.env.NVM_SYMLINK,
		process.env.NVM_HOME ? path.join(process.env.NVM_HOME, 'nodejs') : undefined,
		process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : undefined,
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm') : undefined,
		process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'nodejs') : undefined,
	].filter((value): value is string => Boolean(value));

	const executableNames = process.platform === 'win32' ? ['codex.exe'] : ['codex'];
	for (const directory of [...new Set(directories)]) {
		for (const executableName of executableNames) {
			const candidate = path.join(directory, executableName);
			if (existsSync(candidate)) return candidate;
		}
	}
	return 'codex';
}

function resolvePlatformBinary(): string | undefined {
	if (process.platform !== 'win32') return undefined;
	const packageName = process.arch === 'arm64' ? '@openai/codex-win32-arm64' : '@openai/codex-win32-x64';
	const targetTriple = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
	const packageRoots = [
		process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, 'node_modules') : undefined,
		process.env.NVM_HOME ? path.join(process.env.NVM_HOME, 'nodejs', 'node_modules') : undefined,
		process.env.APPDATA ? path.join(process.env.APPDATA, 'npm', 'node_modules') : undefined,
		process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'pnpm', 'global') : undefined,
	].filter((value): value is string => Boolean(value));
	const directBinaryRoots = [
		...packageRoots,
		process.env.NVM_SYMLINK ? path.join(process.env.NVM_SYMLINK, 'node_modules', '@openai', 'codex') : undefined,
		process.env.NVM_HOME
			? path.join(process.env.NVM_HOME, 'nodejs', 'node_modules', '@openai', 'codex')
			: undefined,
	].filter((value): value is string => Boolean(value));
	for (const root of directBinaryRoots) {
		const binary = path.join(root, 'vendor', targetTriple, 'bin', 'codex.exe');
		if (existsSync(binary)) return binary;
	}
	const requireBases = [
		typeof __filename === 'string' ? __filename : process.execPath,
		...packageRoots.map((root) => path.join(root, 'codex-resolver.js')),
	];
	for (const base of requireBases) {
		try {
			const resolve = createRequire(base).resolve;
			const packageJson = resolve(`${packageName}/package.json`);
			const packageRoot = path.dirname(packageJson);
			const binary = path.join(packageRoot, 'vendor', targetTriple, 'bin', 'codex.exe');
			if (existsSync(binary)) return binary;
		} catch {
			// Try the next installation root.
		}
	}

	// pnpm global installs keep the platform package below <global>/<version>/.pnpm,
	// which is not discoverable by Node's normal module resolution from the plugin.
	const pnpmGlobalRoot = process.env.LOCALAPPDATA
		? path.join(process.env.LOCALAPPDATA, 'pnpm', 'global')
		: undefined;
	if (pnpmGlobalRoot) {
		for (const version of safeReadDirectories(pnpmGlobalRoot)) {
			const storeRoot = path.join(pnpmGlobalRoot, version, '.pnpm');
			for (const packageDirectory of safeReadDirectories(storeRoot)) {
				if (!packageDirectory.startsWith('@openai+codex@')) continue;
				const binary = path.join(
					storeRoot,
					packageDirectory,
					'node_modules',
					'@openai',
					'codex',
					'vendor',
					targetTriple,
					'bin',
					'codex.exe',
				);
				if (existsSync(binary)) return binary;
			}
		}
	}
	return undefined;
}

function safeReadDirectories(directory: string): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
}
