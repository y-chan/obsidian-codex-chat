import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { App, Component, FileSystemAdapter, MarkdownRenderer, setIcon } from 'obsidian';
import path from 'node:path';
import type { CodexMessage, CodexSession, CodexSessionSummary } from '../types/codex';
import { filterSessionSummaries } from '../parsers/CodexHistoryParser';
import { CodexHistoryService } from '../services/CodexHistoryService';
import { WorkingDirectoryService } from '../services/WorkingDirectoryService';
import { CodexAppServerService, type AppServerModel, type AppServerUpdate, type ApprovalDecision, type ThinkingEffort, type UsageStatus } from '../services/CodexAppServerService';
import { decorateDiffBlocks, normalizeToolMarkdown } from './diff';
import { normalizeFilesystemPath } from '../utils/paths';

export interface CodexHistoryAppHandle {
	reload: () => Promise<void>;
	setWorkingDirectory: (value: string) => Promise<void>;
}

interface CodexHistoryAppProps {
	app: App;
	historyService: CodexHistoryService;
	workingDirectoryService: WorkingDirectoryService;
	chatService: CodexAppServerService;
	initialWorkingDirectory: string | undefined;
}

export const CodexHistoryApp = forwardRef<CodexHistoryAppHandle, CodexHistoryAppProps>(function CodexHistoryApp(
	{ app, historyService, workingDirectoryService, chatService, initialWorkingDirectory },
	ref,
) {
	const [workingDirectory, setWorkingDirectoryState] = useState(initialWorkingDirectory ?? '');
	const [sessions, setSessions] = useState<CodexSessionSummary[]>([]);
	const [selectedSessionId, setSelectedSessionId] = useState<string>();
	const [selectedSession, setSelectedSession] = useState<CodexSession>();
	const [searchQuery, setSearchQuery] = useState('');
	const [isLoading, setIsLoading] = useState(false);
	const [isLoadingSession, setIsLoadingSession] = useState(false);
	const [isSessionListOpen, setIsSessionListOpen] = useState(false);
	const [chatMessages, setChatMessages] = useState<CodexMessage[]>([]);
	const [chatThreadId, setChatThreadId] = useState<string>();
	const [isSending, setIsSending] = useState(false);
	const [pendingApproval, setPendingApproval] = useState<AppServerUpdate>();
	const [availableModels, setAvailableModels] = useState<AppServerModel[]>([]);
	const [selectedModel, setSelectedModel] = useState(() => chatService.getModel());
	const [selectedEffort, setSelectedEffort] = useState<ThinkingEffort>(() => chatService.getThinkingEffort());
	const abortControllerRef = useRef<AbortController>();
	const sendingRef = useRef(false);
	const [error, setError] = useState<string>();
	const [workingDirectoryError, setWorkingDirectoryError] = useState<string>();
	const [status, setStatus] = useState('');
	const [usageStatus, setUsageStatus] = useState<UsageStatus>();
	const loadGeneration = useRef(0);
	const sessionGeneration = useRef(0);
	const workingDirectoryGeneration = useRef(0);
	const workingDirectoryValue = useRef(initialWorkingDirectory ?? '');

	useEffect(() => {
		setSelectedModel(chatService.getModel());
		setSelectedEffort(chatService.getThinkingEffort());
		void chatService.listModels().then(setAvailableModels).catch(() => setAvailableModels([]));
		const refreshUsage = () => { void chatService.getUsageStatus().then((next) => setUsageStatus((current) => ({ ...current, ...next }))).catch(() => undefined); };
		refreshUsage();
		const interval = window.setInterval(refreshUsage, 60_000);
		return () => window.clearInterval(interval);
	}, [chatService]);

	const changeModel = useCallback((model: string): void => {
		setSelectedModel(model);
		chatService.setModel(model);
	}, [chatService]);

	const changeEffort = useCallback((effort: ThinkingEffort): void => {
		setSelectedEffort(effort);
		chatService.setThinkingEffort(effort);
	}, [chatService]);

	const load = useCallback(async (directory: string): Promise<void> => {
		if (!directory) {
			setError('Set a working directory to load Codex sessions.');
			return;
		}
		const generation = ++loadGeneration.current;
		setIsLoading(true);
		setError(undefined);
		setStatus('');
		try {
			const snapshot = await historyService.load(directory);
			if (generation !== loadGeneration.current) return;
			setSessions(snapshot.sessions);
			setSelectedSessionId((current) => current && snapshot.sessions.some((session) => session.id === current) ? current : undefined);
			setSelectedSession((current) => current && snapshot.sessions.some((session) => session.id === current.id) ? current : undefined);
			setWorkingDirectoryError(undefined);
			setStatus(`Loaded ${snapshot.sessions.length} session(s).`);
			if (snapshot.errors.length > 0) setError(`${snapshot.errors.length} history file(s) could not be read. Check debug logging for details.`);
		} catch (loadError) {
			if (generation === loadGeneration.current) {
				const message = toErrorMessage(loadError);
				if (isWorkingDirectoryError(message)) setWorkingDirectoryError(message);
				else setError(message);
			}
		} finally {
			if (generation === loadGeneration.current) setIsLoading(false);
		}
	}, [historyService]);

	const setWorkingDirectory = useCallback(async (value: string): Promise<void> => {
		workingDirectoryGeneration.current += 1;
		workingDirectoryValue.current = value;
		setWorkingDirectoryError(undefined);
		setWorkingDirectoryState(value);
		setSelectedSessionId(undefined);
		setSelectedSession(undefined);
		setSearchQuery('');
		await load(value);
	}, [load]);

	const reload = useCallback(async (): Promise<void> => {
		await load(workingDirectory);
	}, [load, workingDirectory]);

	useImperativeHandle(ref, () => ({ reload, setWorkingDirectory }), [reload, setWorkingDirectory]);

	useEffect(() => {
		let active = true;
		const generation = workingDirectoryGeneration.current;
		if (!initialWorkingDirectory) {
			setError('Set a working directory to load Codex sessions.');
			return () => { active = false; };
		}
		void workingDirectoryService.validate(initialWorkingDirectory).then((validated) => {
			if (!active || generation !== workingDirectoryGeneration.current) return;
			setWorkingDirectoryState(validated);
			void load(validated);
		}).catch((validationError: unknown) => {
			if (active && generation === workingDirectoryGeneration.current && workingDirectoryValue.current === initialWorkingDirectory) setWorkingDirectoryError(toErrorMessage(validationError));
		});
		return () => { active = false; };
	}, [initialWorkingDirectory, load, workingDirectoryService]);

	const selectSession = useCallback(async (sessionId: string): Promise<void> => {
		const generation = ++sessionGeneration.current;
		setSelectedSessionId(sessionId);
		setSelectedSession(undefined);
		setUsageStatus((current) => current ? { ...current, contextRemainingPercent: undefined } : current);
		setIsLoadingSession(true);
		try {
			const session = await historyService.getSession(workingDirectory, sessionId);
			if (generation === sessionGeneration.current) {
				setSelectedSession(session);
				setChatThreadId(session.id);
				setChatMessages(session.messages);
				void chatService.getThreadContextUsage(session.id, workingDirectory).then((contextRemainingPercent) => {
					if (generation === sessionGeneration.current && contextRemainingPercent !== undefined) setUsageStatus((current) => ({ ...current, contextRemainingPercent }));
				}).catch(() => undefined);
			}
		} catch (sessionError) {
			if (generation === sessionGeneration.current) setError(toErrorMessage(sessionError));
		} finally {
			if (generation === sessionGeneration.current) setIsLoadingSession(false);
		}
	}, [chatService, historyService, workingDirectory]);

	const sendMessage = useCallback(async (prompt: string, images: string[] = []): Promise<void> => {
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt || !workingDirectory) return;
		if (sendingRef.current) {
			const userMessage: CodexMessage = {
				id: `chat-user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
				role: 'user',
				markdown: trimmedPrompt,
				createdAt: new Date().toISOString(),
			};
			setChatMessages((current) => [...current, userMessage]);
			setSelectedSession((current) => current ?? { id: chatThreadId ?? 'new-chat', title: trimmedPrompt, messages: [] });
			try {
				await chatService.steer({ workingDirectory, threadId: chatThreadId, prompt: trimmedPrompt, images });
				setStatus('Follow-up added.');
			} catch (steerError) {
				setError(toErrorMessage(steerError));
				setStatus('Could not add follow-up.');
			}
			return;
		}
		sendingRef.current = true;
		const userMessage: CodexMessage = {
			id: `chat-user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			role: 'user' as const,
			markdown: trimmedPrompt,
			createdAt: new Date().toISOString(),
		};
		setChatMessages((current) => [...current, userMessage]);
		setSelectedSession((current) => current ?? { id: chatThreadId ?? 'new-chat', title: trimmedPrompt, messages: [] });
		setIsSending(true);
		setError(undefined);
		setStatus('Starting…');
		const abortController = new AbortController();
		abortControllerRef.current = abortController;
		let streamedAssistantId: string | undefined;
		const applyStreamUpdate = (update: AppServerUpdate): void => {
			if (update.kind === 'usage') {
				if (update.usage) setUsageStatus((current) => ({ ...current, ...update.usage }));
				return;
			}
			if (update.kind === 'approval') {
				setPendingApproval(update);
				setStatus('Approval required.');
				return;
			}
			if (update.kind === 'status') {
				setStatus(update.text);
				return;
			}
			if (!update.id) return;
			if (update.kind === 'assistant') streamedAssistantId = `chat-assistant-${update.id}`;
			setChatMessages((current) => {
				const nextMessage: CodexMessage = {
					id: `chat-${update.kind}-${update.id}`,
					role: update.kind === 'assistant' ? 'assistant' : 'tool',
					markdown: update.text,
					createdAt: new Date().toISOString(),
					metadata: update.kind === 'tool' ? { kind: 'tool', toolName: update.toolName } : undefined,
				};
				const index = current.findIndex((message) => message.id === nextMessage.id);
				if (index < 0) return [...current, nextMessage];
				const copy = [...current];
				copy[index] = nextMessage;
				return copy;
			});
		};
		try {
			const result = await chatService.send({ workingDirectory, threadId: chatThreadId, prompt: trimmedPrompt, images, signal: abortController.signal }, applyStreamUpdate);
			if (result.threadId) setChatThreadId(result.threadId);
			if (result.finalResponse) {
				setChatMessages((current) => {
					const id = streamedAssistantId ?? `chat-assistant-${Date.now()}`;
					const message: CodexMessage = { id, role: 'assistant', markdown: result.finalResponse, createdAt: new Date().toISOString() };
					const existingIndex = current.findIndex((item) => item.id === id);
					if (existingIndex < 0) return [...current, message];
					const copy = [...current];
					copy[existingIndex] = message;
					return copy;
				});
			}
		} catch (sendError) {
			if (abortController.signal.aborted) setStatus('Stopped.');
			else {
				setError(toErrorMessage(sendError));
				setStatus('Codex failed.');
			}
		} finally {
			setPendingApproval(undefined);
			abortControllerRef.current = undefined;
			sendingRef.current = false;
			setIsSending(false);
		}
	}, [chatService, chatThreadId, workingDirectory]);

	const stopMessage = useCallback((): void => {
		abortControllerRef.current?.abort();
	}, []);

	const startNewChat = useCallback((): void => {
		stopMessage();
		setSelectedSessionId(undefined);
		setSelectedSession(undefined);
		setChatThreadId(undefined);
		setChatMessages([]);
		setUsageStatus((current) => current ? { ...current, contextRemainingPercent: undefined } : current);
		setPendingApproval(undefined);
		setStatus('New chat.');
	}, [stopMessage]);

	const displaySession = selectedSession
		? { ...selectedSession, messages: chatMessages }
		: chatMessages.length > 0
			? { id: chatThreadId ?? 'new-chat', title: chatMessages.find((message) => message.role === 'user')?.markdown, messages: chatMessages }
			: undefined;

	return (
		<div className="codex-history-view">
			<div className="codex-history-toolbar">
				<WorkingDirectorySelector
					service={workingDirectoryService}
					initialValue={workingDirectory}
					onChange={setWorkingDirectory}
					onError={setWorkingDirectoryError}
					error={workingDirectoryError}
				reloadButton={<IconButton icon="refresh-cw" label="Reload Codex sessions" className="codex-history-reload" onClick={() => void reload()} disabled={isLoading}>Reload</IconButton>}
				/>
			</div>
			{error && <div className="codex-history-error">{error}</div>}
			{status && !error && !isSending && <div className="codex-history-status">{isLoading && <span className="codex-history-status-indicator" aria-hidden="true" />}{status}</div>}
			<div className="codex-history-content">
				<div className="codex-history-content-actions">
					<IconButton icon="messages-square" label={isSessionListOpen ? 'Hide sessions' : 'Show sessions'} className="codex-history-session-toggle" onClick={() => setIsSessionListOpen((open) => !open)} />
					<IconButton icon="message-circle-plus" label="New chat" className="codex-history-new-chat" onClick={startNewChat} />
					<ModelSelector value={selectedModel} models={availableModels} onChange={changeModel} />
					<ThinkingEffortSelector value={selectedEffort} onChange={changeEffort} />
				</div>
				<div className="codex-history-split">
					{isSessionListOpen && <div aria-hidden="true" className="codex-history-list-backdrop" onClick={() => setIsSessionListOpen(false)} />}
					<SessionListPane open={isSessionListOpen} sessions={sessions} selectedId={selectedSessionId} query={searchQuery} onSearch={setSearchQuery} onSelect={(id) => { setIsSessionListOpen(false); void selectSession(id); }} />
			<SessionDetailPane app={app} session={displaySession} loading={isLoadingSession} error={selectedSessionId && !isLoadingSession && !selectedSession ? error : undefined} status={isSending ? status : undefined} usage={usageStatus} approval={pendingApproval} isSending={isSending} onSend={sendMessage} onStop={stopMessage} onApproval={(decision) => { pendingApproval?.decision?.(decision); setPendingApproval(undefined); }} />
				</div>
			</div>
		</div>
	);
});

interface WorkingDirectorySelectorProps {
	service: WorkingDirectoryService;
	initialValue: string;
	onChange: (value: string) => Promise<void>;
	onError: (message?: string) => void;
	error?: string;
	reloadButton: ReactNode;
}

function WorkingDirectorySelector({ service, initialValue, onChange, onError, error, reloadButton }: WorkingDirectorySelectorProps) {
	const [value, setValue] = useState(initialValue);
	const [status, setStatus] = useState('');
	const [isError, setIsError] = useState(false);
	const committedValue = useRef(initialValue);
	const directoryInputRef = useRef<HTMLInputElement>(null);
	const validationGeneration = useRef(0);

	useEffect(() => {
		directoryInputRef.current?.setAttribute('webkitdirectory', '');
	}, []);

	useEffect(() => {
		setValue(initialValue);
		committedValue.current = initialValue;
	}, [initialValue]);

	const commit = async (nextValue: string): Promise<void> => {
		if (!nextValue || nextValue === committedValue.current) return;
		const generation = ++validationGeneration.current;
		setStatus('');
		setIsError(false);
		onError(undefined);
		try {
			const validated = await service.validate(nextValue);
			if (generation !== validationGeneration.current) return;
			committedValue.current = validated;
			setValue(validated);
			setStatus('');
			setIsError(false);
			await onChange(validated);
		} catch (validationError) {
			if (generation !== validationGeneration.current) return;
			const message = toErrorMessage(validationError);
			setStatus(message);
			setIsError(true);
			onError(message);
		}
	};

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void commit(value);
	};

	const usePath = (path: string | undefined) => {
		if (!path) {
			const message = 'The vault is not on a local filesystem, or no file is active.';
			setStatus(message);
			setIsError(true);
			onError(message);
			return;
		}
		setValue(path);
		void commit(path);
	};

	const chooseDirectory = (event: ChangeEvent<HTMLInputElement>): void => {
		const file = event.target.files?.[0];
		const absolutePath = file ? (file as File & { path?: string }).path : undefined;
		const relativePath = file?.webkitRelativePath?.replaceAll('/', '\\');
		if (!absolutePath || !relativePath) {
			setStatus('Could not determine the selected folder path.');
			setIsError(true);
			event.target.value = '';
			return;
		}
		const relativeParts = relativePath.split('\\');
		const fileInsideDirectory = relativeParts.slice(1).join('\\');
		const directory = fileInsideDirectory
			? absolutePath.slice(0, absolutePath.length - fileInsideDirectory.length).replace(/[\\/]$/, '')
			: absolutePath.slice(0, absolutePath.length - relativePath.length).replace(/[\\/]$/, '');
		event.target.value = '';
		usePath(directory);
	};

	const openDirectoryPicker = async (): Promise<void> => {
		const dialog = getNativeDirectoryDialog();
		if (!dialog) {
			directoryInputRef.current?.click();
			return;
		}
		try {
			const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
			if (!result.canceled && result.filePaths[0]) usePath(result.filePaths[0]);
		} catch (pickerError) {
			setStatus(toErrorMessage(pickerError));
			setIsError(true);
			onError(toErrorMessage(pickerError));
		}
	};

	return (
		<div className="codex-history-working-directory">
			<div className="codex-history-working-directory-controls">
				<form onSubmit={submit}>
					<label>
						Working directory
					<input type="text" value={value} placeholder="Vault-relative path or absolute path" onChange={(event) => { setValue(event.target.value); setStatus(''); setIsError(false); onError(undefined); }} onBlur={(event) => void commit(event.currentTarget.value)} />
					</label>
				</form>
				<div className="codex-history-directory-actions">
					<input ref={directoryInputRef} className="codex-history-file-input" type="file" onChange={chooseDirectory} />
					<IconButton icon="folder-open" label="Choose working directory" onClick={() => void openDirectoryPicker()} />
				</div>
				{reloadButton}
			</div>
			<div className={`codex-history-inline-status${isError || error ? ' mod-warning' : ''}`}>{status || error}</div>
		</div>
	);
}

interface NativeDirectoryDialog {
	showOpenDialog: (options: { properties: string[] }) => Promise<{ canceled: boolean; filePaths: string[] }>;
}

function getNativeDirectoryDialog(): NativeDirectoryDialog | undefined {
	try {
		const windowWithRequire = window as Window & { require?: (moduleName: string) => unknown };
		if (!windowWithRequire.require) return undefined;
		const electron = windowWithRequire.require('electron') as { dialog?: NativeDirectoryDialog; remote?: { dialog?: NativeDirectoryDialog } };
		return electron.remote?.dialog ?? electron.dialog;
	} catch {
		return undefined;
	}
}

interface SessionListPaneProps {
	open: boolean;
	sessions: CodexSessionSummary[];
	selectedId: string | undefined;
	query: string;
	onSearch: (query: string) => void;
	onSelect: (sessionId: string) => void;
}

function SessionListPane({ open, sessions, selectedId, query, onSearch, onSelect }: SessionListPaneProps) {
	const visibleSessions = filterSessionSummaries(sessions, query);
	return (
		<div className={`codex-history-list-pane${open ? ' is-open' : ''}`}>
			<div className="codex-history-list-header">
				<div className="codex-history-list-title-row"><h3>Sessions</h3><span className="codex-history-session-count">{visibleSessions.length}/{sessions.length}</span></div>
				<input type="search" value={query} placeholder="Search sessions" onChange={(event) => onSearch(event.target.value)} />
			</div>
			<div className="codex-history-session-list">
				{visibleSessions.length === 0 ? <div className="codex-history-empty">{sessions.length === 0 ? 'No sessions found.' : 'No matching sessions.'}</div> : visibleSessions.map((session) => (
					<button key={session.id} className={`codex-history-session-item${session.id === selectedId ? ' is-selected' : ''}`} type="button" onClick={() => onSelect(session.id)}>
						<div className="codex-history-session-title" title={session.title || session.preview || session.id}>{session.title || session.preview || 'Untitled session'}</div>
					</button>
				))}
			</div>
		</div>
	);
}

function ModelSelector({ value, models, onChange }: { value: string; models: AppServerModel[]; onChange: (value: string) => void }) {
	const hasCurrentModel = !value || models.some((model) => model.id === value);
	return <label className="codex-history-model-selector" title="Model for new turns">
		<span>Model</span>
		<select value={value} onChange={(event) => onChange(event.target.value)}>
			<option value="">CLI default</option>
			{!hasCurrentModel && <option value={value}>{value}</option>}
			{models.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}
		</select>
	</label>;
}

function ThinkingEffortSelector({ value, onChange }: { value: ThinkingEffort; onChange: (value: ThinkingEffort) => void }) {
	return <label className="codex-history-effort-selector" title="Thinking effort for new turns">
		<span>Thinking</span>
		<select value={value} onChange={(event) => onChange(event.target.value as ThinkingEffort)}>
			<option value="">CLI default</option>
			<option value="minimal">Minimal</option>
			<option value="low">Low</option>
			<option value="medium">Medium</option>
			<option value="high">High</option>
			<option value="xhigh">Xhigh</option>
		</select>
	</label>;
}

interface SessionDetailPaneProps {
	app: App;
	session: CodexSession | undefined;
	loading: boolean;
	error: string | undefined;
	status: string | undefined;
	usage: UsageStatus | undefined;
	approval: AppServerUpdate | undefined;
	isSending: boolean;
	onSend: (prompt: string, images?: string[]) => Promise<void>;
	onStop: () => void;
	onApproval: (decision: ApprovalDecision) => void;
}

function SessionDetailPane({ app, session, loading, error, status, usage, approval, isSending, onSend, onStop, onApproval }: SessionDetailPaneProps) {
	const messagesRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const element = messagesRef.current;
		if (!element) return;
		const scrollToBottom = () => { element.scrollTop = element.scrollHeight; };
		scrollToBottom();
		const observer = new ResizeObserver(scrollToBottom);
		observer.observe(element);
		return () => observer.disconnect();
	}, [loading, session?.id, session?.messages.length]);

	return (
		<div className="codex-history-detail-pane">
			<div className="codex-history-detail-header">
				<div className="codex-history-detail-title-row">
					<h2>{session?.title || 'New chat'}</h2>
				</div>
				{session && <div className="codex-history-session-meta">{session.id}</div>}
			</div>
			<div ref={messagesRef} className="codex-history-messages">
				{loading ? <div className="codex-history-state">Loading session…</div> : error ? <div className="codex-history-error">{error}</div> : !session ? <div className="codex-history-state">Start a conversation with Codex.</div> : session.messages.length === 0 ? <div className="codex-history-empty">This session has no renderable messages.</div> : session.messages.map((message) => message.role === 'tool'
					? <CollapsedCommand key={message.id} app={app} sessionId={session.id} message={message} />
					: <MarkdownMessage key={message.id} app={app} sessionId={session.id} message={message} />)}
			</div>
			{approval && <ApprovalCard approval={approval} onDecision={onApproval} />}
			{isSending && status && <div className="codex-history-composer-status"><span className="codex-history-status-indicator" aria-hidden="true" />{status.replace(/^Codex /, '')}</div>}
			<ChatComposer disabled={loading} isSending={isSending} usage={usage} onSend={onSend} onStop={onStop} />
		</div>
	);
}

function ApprovalCard({ approval, onDecision }: { approval: AppServerUpdate; onDecision: (decision: ApprovalDecision) => void }) {
	return <div className="codex-history-approval-card">
		<div className="codex-history-approval-title">Approval required</div>
		<div className="codex-history-approval-kind">{approval.approvalKind === 'fileChange' ? 'File change' : 'Command'}</div>
		<pre>{approval.text}</pre>
		<div className="codex-history-approval-actions">
			<button type="button" onClick={() => onDecision('accept')}>Approve</button>
			<button type="button" onClick={() => onDecision('acceptForSession')}>Approve for session</button>
			<button type="button" className="mod-warning" onClick={() => onDecision('decline')}>Decline</button>
		</div>
	</div>;
}

function ChatComposer({ disabled, isSending, usage, onSend, onStop }: { disabled: boolean; isSending: boolean; usage: UsageStatus | undefined; onSend: (prompt: string, images?: string[]) => Promise<void>; onStop: () => void }) {
	const [value, setValue] = useState('');
	const [images, setImages] = useState<string[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const submit = async (): Promise<void> => {
		const prompt = value.trim();
		if (!prompt || disabled) return;
		setValue('');
		const selectedImages = [...images];
		setImages([]);
		await onSend(prompt, selectedImages);
	};
	const selectImages = (event: ChangeEvent<HTMLInputElement>): void => {
		const paths = Array.from(event.target.files ?? []).map((file) => (file as File & { path?: string }).path).filter((path): path is string => Boolean(path));
		setImages((current) => [...current, ...paths]);
		event.target.value = '';
	};
	useEffect(() => {
		const handleCommand = (): void => {
			if (document.activeElement instanceof HTMLTextAreaElement && document.activeElement.closest('.codex-history-composer')) void submit();
		};
		document.addEventListener('codex-history-send', handleCommand);
		return () => document.removeEventListener('codex-history-send', handleCommand);
	}, [disabled, isSending, value, images]);
	return (
		<div className="codex-history-composer-wrap">
		<form className="codex-history-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
			<input ref={fileInputRef} className="codex-history-file-input" type="file" accept="image/*" multiple onChange={selectImages} />
			<IconButton icon="paperclip" label="Attach images" className="codex-history-upload" onClick={() => fileInputRef.current?.click()} disabled={disabled} />
			<textarea value={value} disabled={disabled} placeholder={isSending ? 'Add a follow-up…' : 'Ask Codex…'} rows={3} onChange={(event) => setValue(event.target.value)} />
			{isSending && <IconButton icon="square" label="Stop" className="codex-history-stop" onClick={onStop} />}
			<IconButton icon="arrow-up" label={isSending ? 'Queue follow-up' : 'Send'} className="codex-history-send" onClick={() => void submit()} disabled={disabled || !value.trim()} />
			{images.length > 0 && <span className="codex-history-attachment-count">{images.length} image{images.length === 1 ? '' : 's'}</span>}
		</form>
			<UsageBar usage={usage} />
		</div>
	);
}

function UsageBar({ usage }: { usage: UsageStatus | undefined }) {
	if (!usage || (!usage.accountName && !usage.plan && usage.contextRemainingPercent === undefined && !usage.fiveHour && !usage.weekly)) return null;
	return <div className="codex-history-usage" aria-label="Codex usage status">
		<div className="codex-history-usage-account" title={usage.accountName}>{usage.accountName ?? 'Codex'}{usage.plan ? ` (${usage.plan})` : ''}</div>
		<UsageMetric label="Context Window Remain" value={formatPercent(usage.contextRemainingPercent)} percent={usage.contextRemainingPercent} />
		{usage.fiveHour && <UsageMetric label="5h limit" value={formatPercent(usage.fiveHour.remainingPercent)} percent={usage.fiveHour.remainingPercent} />}
		{usage.weekly && <UsageMetric label="Weekly limit" value={formatPercent(usage.weekly.remainingPercent)} percent={usage.weekly.remainingPercent} />}
	</div>;
}

function UsageMetric({ label, value, percent }: { label: string; value: string | undefined; percent: number | undefined }) {
	if (!value) return null;
	return <div className="codex-history-usage-metric" title={label}>
		<span className="codex-history-usage-label">{label}</span>
		<span className="codex-history-usage-value">{value}</span>
		<span className="codex-history-usage-track"><span style={{ width: `${percent ?? 0}%` }} /></span>
	</div>;
}

function formatPercent(value: number | undefined): string | undefined { return value === undefined ? undefined : `${value}%`; }

function CollapsedCommand({ app, sessionId, message }: { app: App; sessionId: string; message: CodexMessage }) {
	return (
		<details className="codex-history-command">
			<summary>{commandSummary(message)}</summary>
			<MarkdownMessage app={app} sessionId={sessionId} message={message} />
		</details>
	);
}

function commandSummary(message: CodexMessage): string {
	if (message.metadata?.kind === 'subagent') {
		const nickname = typeof message.metadata.agentNickname === 'string' ? ` (${message.metadata.agentNickname})` : '';
		return `Subagent${nickname}`;
	}
	const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : undefined;
	if (toolName && /approve|approval|guardian/i.test(toolName)) return `Approve (${toolName})`;
	if (toolName === 'apply_patch') return 'Apply patch';
	return toolName ? `Command: ${toolName}` : 'Command history';
}

function MarkdownMessage({ app, sessionId, message }: { app: App; sessionId: string; message: CodexMessage }) {
	const bodyRef = useRef<HTMLDivElement>(null);
	const [renderError, setRenderError] = useState<string>();

	useEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		const component = new Component();
		setRenderError(undefined);
		const toolName = typeof message.metadata?.toolName === 'string' ? message.metadata.toolName : undefined;
		const handleLinkClick = (event: MouseEvent): void => {
			const target = event.target instanceof HTMLElement ? event.target.closest('a') : null;
			const href = target?.getAttribute('href') ?? '';
			const internalHref = target?.getAttribute('data-href');
			const linkText = internalHref || href;
			if (!linkText || href?.startsWith('#')) return;
			event.preventDefault();
			event.stopPropagation();
			if (/^(https?:|mailto:|tel:|obsidian:)/i.test(href)) {
				window.open(href, '_blank', 'noopener,noreferrer');
				return;
			}
			const pathPart = linkText.split('#')[0] ?? linkText;
			openHistoryFileLink(app, pathPart);
		};
		body.addEventListener('click', handleLinkClick);
		void MarkdownRenderer.render(app, normalizeToolMarkdown(message.markdown, toolName), body, sessionId, component)
			.then(() => decorateDiffBlocks(body))
			.catch((error: unknown) => setRenderError(toErrorMessage(error)));
		return () => {
			body.removeEventListener('click', handleLinkClick);
			component.unload();
			body.replaceChildren();
		};
	}, [app, message, sessionId]);

	return (
		<div className={`codex-history-message codex-history-role-${message.role}`}>
			<div className="codex-history-message-header"><span>{message.role}</span>{message.createdAt && <span>{new Date(message.createdAt).toLocaleString()}</span>}</div>
			<div ref={bodyRef} className="codex-history-message-body" />
			{renderError && <div className="codex-history-error">{renderError}</div>}
		</div>
	);
}

function openHistoryFileLink(app: App, rawLink: string): void {
	const decoded = safeDecodeURIComponent(rawLink);
	const filesystemPath = toFilesystemPath(decoded);
	const pathApi = process.platform === 'win32' ? path.win32 : path;
	const root = app.vault.adapter instanceof FileSystemAdapter
		? normalizeFilesystemPath(app.vault.adapter.getBasePath())
		: undefined;

	if (filesystemPath && pathApi.isAbsolute(filesystemPath)) {
		const target = normalizeFilesystemPath(filesystemPath);
		if (root) {
			const relative = pathApi.relative(root, target);
			const outsideVault = relative === '..' || relative.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(relative);
			if (!outsideVault) {
				void app.workspace.openLinkText((relative || '.').split(pathApi.sep).join('/'), '', false);
				return;
			}
		}
		// Never pass an external absolute path to openLinkText: Obsidian treats
		// it as a vault-relative path and may create folders such as "Users".
		openExternalPath(target);
		return;
	}

	void app.workspace.openLinkText(decoded, '', false);
}

function openExternalPath(target: string): void {
	try {
		const windowWithRequire = window as Window & { require?: (moduleName: string) => unknown };
		const electron = windowWithRequire.require?.('electron') as { shell?: { openPath?: (path: string) => Promise<string> } } | undefined;
		if (electron?.shell?.openPath) {
			void electron.shell.openPath(target);
			return;
		}
	} catch {
		// Fall back to the browser's file handler below.
	}
	window.open(pathToFileUrl(target), '_blank', 'noopener,noreferrer');
}

function pathToFileUrl(target: string): string {
	const normalized = target.replaceAll('\\', '/');
	return normalized.startsWith('/') ? `file://${encodeURI(normalized)}` : `file:///${encodeURI(normalized)}`;
}

function toFilesystemPath(value: string): string | undefined {
	if (/^file:/i.test(value)) {
		try {
			const url = new URL(value);
			const pathname = decodeURIComponent(url.pathname);
			if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(pathname)) return pathname.slice(1);
			return pathname;
		} catch {
			return undefined;
		}
	}
	return /^\/(?:Users|Volumes|private|tmp)(?:\/|$)/.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) ? value : undefined;
}

function safeDecodeURIComponent(value: string): string {
	try { return decodeURIComponent(value); } catch { return value; }
}

interface IconButtonProps {
	icon: string;
	label: string;
	className?: string;
	disabled?: boolean;
	onClick: () => void;
	children?: ReactNode;
}

function IconButton({ icon, label, className, disabled, onClick, children }: IconButtonProps) {
	const buttonRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (buttonRef.current) setIcon(buttonRef.current, icon);
	}, [icon]);
	return <button ref={buttonRef} className={className} type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}>{children}</button>;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isWorkingDirectoryError(message: string): boolean {
	return message.startsWith('Working directory ');
}
