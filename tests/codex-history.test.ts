import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { filterSessionSummaries, parseCodexHistoryText, sortSessionSummaries } from '../src/parsers/CodexHistoryParser.ts';
import { normalizeFilesystemPath, validateWorkingDirectory } from '../src/utils/paths.ts';

void test('normalizes Windows and Git Bash paths', () => {
	assert.equal(normalizeFilesystemPath('/c/Users/test/project', 'win32'), 'C:\\Users\\test\\project');
	assert.equal(normalizeFilesystemPath('C:/Users/test/../project', 'win32'), 'C:\\Users\\project');
});

void test('validates an existing directory and rejects a file', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'codex-history-'));
	const file = path.join(root, 'file.txt');
	await writeFile(file, 'fixture', 'utf8');
	assert.equal(await validateWorkingDirectory(root), root);
	await assert.rejects(() => validateWorkingDirectory(file), /not a directory/);
	await assert.rejects(() => validateWorkingDirectory(path.join(root, 'missing')), /does not exist/);
});

void test('parses JSON history with Markdown and formula text', () => {
	const parsed = parseCodexHistoryText(JSON.stringify({ id: 'json-session', messages: [{ role: 'assistant', text: 'Long markdown $$a=b$$' }] }), 'history.json');
	assert.equal(parsed.session.id, 'json-session');
	assert.match(parsed.session.messages[0]?.markdown ?? '', /a=b/);
});

void test('parses JSONL with a broken line and unknown role', () => {
	const text = [
		JSON.stringify({ type: 'session_meta', payload: { id: 'jsonl-session', cwd: 'C:\\work\\demo' } }),
		JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'hello' } }),
		'broken line',
		JSON.stringify({ type: 'new_event', payload: { value: 'future' } }),
	].join('\n');
	const parsed = parseCodexHistoryText(text, 'rollout.jsonl');
	assert.equal(parsed.parseErrors, 1);
	assert.equal(parsed.session.messages.length, 1);
	assert.equal(parsed.session.messages[0]?.role, 'user');
	assert.equal(parsed.session.title, 'hello');
});

void test('deduplicates event and response records with the same visible message', () => {
	const text = [
		JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'same question' } }),
		JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'same question' }] } }),
		JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'same answer' } }),
		JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'same answer' }] } }),
	].join('\n');
	const parsed = parseCodexHistoryText(text, 'duplicate.jsonl');
	assert.deepEqual(parsed.session.messages.map((message) => `${message.role}:${message.markdown}`), ['user:same question', 'assistant:same answer']);
});

void test('does not derive a title from assistant-only execution logs', () => {
	const text = [
		JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'agent-generated user message' }] } }),
		JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'background result' }] } }),
	].join('\n');
	const parsed = parseCodexHistoryText(text, 'execution-log.jsonl');
	assert.equal(parsed.session.title, undefined);
	assert.equal(parsed.session.messages.length, 1);
});

void test('reads thread_source from session metadata', () => {
	const parsed = parseCodexHistoryText(JSON.stringify({ type: 'session_meta', payload: { id: 'user-session', thread_source: 'user' } }), 'user-session.jsonl');
	assert.equal(parsed.threadSource, 'user');
});

void test('merges tool call output and extracts spawned subagent id', () => {
	const text = [
		JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'call-1', name: 'exec', input: 'tools.multi_agent_v1__spawn_agent({})' } }),
		JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: [{ type: 'input_text', text: '{"agent_id":"child-1"}' }] } }),
	].join('\n');
	const parsed = parseCodexHistoryText(text, 'subagent-parent.jsonl');
	assert.equal(parsed.session.messages.length, 1);
	assert.equal(parsed.session.messages[0]?.metadata?.toolName, 'subagent spawn');
	assert.equal(parsed.session.messages[0]?.metadata?.subagentId, 'child-1');
	assert.match(parsed.session.messages[0]?.markdown ?? '', /Result/);
});

void test('formats patch and shell tool calls as their meaningful content', () => {
	const text = [
		JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'patch-1', name: 'apply_patch', input: ['*** Begin Patch', '*** Update File: note.md', '@@', '-old', '+new', '*** End Patch'].join('\n') } }),
		JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'shell-1', name: 'shell_command', arguments: JSON.stringify({ command: 'pnpm test', workdir: 'C:\\repo' }) } }),
	].join('\n');
	const parsed = parseCodexHistoryText(text, 'tool-format.jsonl');
	assert.match(parsed.session.messages[0]?.markdown ?? '', /```diff/);
	assert.match(parsed.session.messages[0]?.markdown ?? '', /Update File: note\.md/);
	assert.doesNotMatch(parsed.session.messages[0]?.markdown ?? '', /"name"/);
	assert.equal(parsed.session.messages[1]?.markdown, '```sh\npnpm test\n```');
});

void test('hides system prompts, AGENTS instructions, and tool JSON', () => {
	const text = [
		JSON.stringify({ type: 'session_meta', payload: { id: 'clean-session' } }),
		JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions\n<environment_context>secret</environment_context>' }] } }),
		JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'run', arguments: '{"command":"ls"}' } }),
		JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Make the title readable' } }),
		JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } }),
	].join('\n');
	const parsed = parseCodexHistoryText(text, 'clean.jsonl');
	assert.deepEqual(parsed.session.messages.map((message) => message.role), ['tool', 'user', 'assistant']);
	assert.equal(parsed.session.title, 'Make the title readable');
	assert.equal(parsed.session.messages.some((message) => message.markdown.includes('AGENTS.md')), false);
});

void test('handles empty history and long Markdown', () => {
	const parsed = parseCodexHistoryText('', 'empty.jsonl');
	assert.equal(parsed.session.messages.length, 0);
	const longMarkdown = 'x'.repeat(100_000);
	const longParsed = parseCodexHistoryText(JSON.stringify({ id: 'long', role: 'assistant', markdown: longMarkdown }), 'long.json');
	assert.equal(longParsed.session.messages[0]?.markdown.length, longMarkdown.length);
});

void test('sorts sessions by updated time and filters text', () => {
	const sessions = [
		{ id: 'old', title: 'Old', updatedAt: '2026-01-01T00:00:00Z' },
		{ id: 'new', title: 'New task', updatedAt: '2026-01-03T00:00:00Z' },
	];
	assert.deepEqual(sortSessionSummaries(sessions).map((session) => session.id), ['new', 'old']);
	assert.deepEqual(filterSessionSummaries(sessions, 'task').map((session) => session.id), ['new']);
});

void test('creates anonymous fixture directory for test environments', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'codex-history-fixture-'));
	await mkdir(path.join(root, 'nested'));
	assert.equal((await stat(root)).isDirectory(), true);
});

void test('parses the anonymized rollout fixture', async () => {
	const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'anonymous-rollout.jsonl');
	const parsed = parseCodexHistoryText(await readFile(fixturePath, 'utf8'), fixturePath);
	assert.equal(parsed.session.id, 'fixture-session-001');
	assert.equal(parsed.parseErrors, 1);
	assert.deepEqual(parsed.session.messages.map((message) => message.role), ['user', 'assistant']);
	assert.equal(parsed.session.title, 'Fixture session');
});
