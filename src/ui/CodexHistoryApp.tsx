import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import type { CodexMessage, CodexSession, CodexSessionSummary } from '../types/codex';
import { filterSessionSummaries } from '../parsers/CodexHistoryParser';
import { CodexHistoryService } from '../services/CodexHistoryService';
import { WorkingDirectoryService } from '../services/WorkingDirectoryService';
import { CodexChatService, type ChatStreamUpdate } from '../services/CodexChatService';

export interface CodexHistoryAppHandle {
	reload: () => Promise<void>;
	setWorkingDirectory: (value: string) => Promise<void>;
}

interface CodexHistoryAppProps {
	app: App;
	historyService: CodexHistoryService;
	workingDirectoryService: WorkingDirectoryService;
	chatService: CodexChatService;
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
	const abortControllerRef = useRef<AbortController>();
	const [error, setError] = useState<string>();
	const [status, setStatus] = useState('');
	const loadGeneration = useRef(0);
	const sessionGeneration = useRef(0);

	const load = useCallback(async (directory: string): Promise<void> => {
		if (!directory) {
			setError('Set a working directory to load Codex history.');
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
			setStatus(`Loaded ${snapshot.sessions.length} session(s).`);
			if (snapshot.errors.length > 0) setError(`${snapshot.errors.length} history file(s) could not be read. Check debug logging for details.`);
		} catch (loadError) {
			if (generation === loadGeneration.current) setError(toErrorMessage(loadError));
		} finally {
			if (generation === loadGeneration.current) setIsLoading(false);
		}
	}, [historyService]);

	const setWorkingDirectory = useCallback(async (value: string): Promise<void> => {
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
		if (!initialWorkingDirectory) {
			setError('Set a working directory to load Codex history.');
			return () => { active = false; };
		}
		void workingDirectoryService.validate(initialWorkingDirectory).then((validated) => {
			if (!active) return;
			setWorkingDirectoryState(validated);
			void load(validated);
		}).catch((validationError: unknown) => {
			if (active) setError(toErrorMessage(validationError));
		});
		return () => { active = false; };
	}, [initialWorkingDirectory, load, workingDirectoryService]);

	const selectSession = useCallback(async (sessionId: string): Promise<void> => {
		const generation = ++sessionGeneration.current;
		setSelectedSessionId(sessionId);
		setSelectedSession(undefined);
		setIsLoadingSession(true);
		try {
			const session = await historyService.getSession(workingDirectory, sessionId);
			if (generation === sessionGeneration.current) {
				setSelectedSession(session);
				setChatThreadId(session.id);
				setChatMessages(session.messages);
			}
		} catch (sessionError) {
			if (generation === sessionGeneration.current) setError(toErrorMessage(sessionError));
		} finally {
			if (generation === sessionGeneration.current) setIsLoadingSession(false);
		}
	}, [historyService, workingDirectory]);

	const sendMessage = useCallback(async (prompt: string, images: string[] = []): Promise<void> => {
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt || !workingDirectory || isSending) return;
		const userMessage: CodexMessage = {
			id: `chat-user-${Date.now()}`,
			role: 'user',
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
		const applyStreamUpdate = (update: ChatStreamUpdate): void => {
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
			abortControllerRef.current = undefined;
			setIsSending(false);
		}
	}, [chatService, chatThreadId, isSending, workingDirectory]);

	const stopMessage = useCallback((): void => {
		abortControllerRef.current?.abort();
	}, []);

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
					onError={setError}
				/>
				<IconButton icon="refresh-cw" label="Reload Codex history" className="codex-history-reload" onClick={() => void reload()} disabled={isLoading}>
					Reload
				</IconButton>
			</div>
			{error && <div className="codex-history-error">{error}</div>}
			{status && !error && !isSending && <div className="codex-history-status">{isLoading && <span className="codex-history-status-indicator" aria-hidden="true" />}{status}</div>}
			<div className="codex-history-content">
				<IconButton icon="list" label={isSessionListOpen ? 'Hide sessions' : 'Show sessions'} className="codex-history-session-toggle" onClick={() => setIsSessionListOpen((open) => !open)} />
				<div className="codex-history-split">
					{isSessionListOpen && <div aria-hidden="true" className="codex-history-list-backdrop" onClick={() => setIsSessionListOpen(false)} />}
					<SessionListPane open={isSessionListOpen} sessions={sessions} selectedId={selectedSessionId} query={searchQuery} onSearch={setSearchQuery} onSelect={(id) => { setIsSessionListOpen(false); void selectSession(id); }} />
				<SessionDetailPane app={app} session={displaySession} loading={isLoadingSession} error={selectedSessionId && !isLoadingSession && !selectedSession ? error : undefined} status={isSending ? status : undefined} isSending={isSending} onSend={sendMessage} onStop={stopMessage} />
				</div>
			</div>
		</div>
	);
});

interface WorkingDirectorySelectorProps {
	service: WorkingDirectoryService;
	initialValue: string;
	onChange: (value: string) => Promise<void>;
	onError: (message: string) => void;
}

function WorkingDirectorySelector({ service, initialValue, onChange, onError }: WorkingDirectorySelectorProps) {
	const [value, setValue] = useState(initialValue);
	const [status, setStatus] = useState('');
	const [isError, setIsError] = useState(false);
	const committedValue = useRef(initialValue);
	const directoryInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		directoryInputRef.current?.setAttribute('webkitdirectory', '');
	}, []);

	useEffect(() => {
		setValue(initialValue);
		committedValue.current = initialValue;
	}, [initialValue]);

	const commit = async (nextValue: string): Promise<void> => {
		if (!nextValue || nextValue === committedValue.current) return;
		try {
			const validated = await service.validate(nextValue);
			committedValue.current = validated;
			setValue(validated);
			setStatus('');
			setIsError(false);
			await onChange(validated);
		} catch (validationError) {
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
		const file = event.target.files?.[0] as (File & { path?: string; webkitRelativePath?: string }) | undefined;
		const absolutePath = file?.path;
		const relativePath = file?.webkitRelativePath?.replaceAll('/', '\\');
		if (!absolutePath || !relativePath) {
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

	return (
		<div className="codex-history-working-directory">
			<form onSubmit={submit}>
				<label>
					Working directory
					<input type="text" value={value} placeholder="Absolute path" onChange={(event) => setValue(event.target.value)} onBlur={() => void commit(value)} />
				</label>
			</form>
			<div className="codex-history-directory-actions">
				<input ref={directoryInputRef} className="codex-history-file-input" type="file" onChange={chooseDirectory} />
				<IconButton icon="folder-open" label="Choose working directory" onClick={() => directoryInputRef.current?.click()} />
			</div>
			<div className={`codex-history-inline-status${isError ? ' mod-warning' : ''}`}>{status}</div>
		</div>
	);
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

interface SessionDetailPaneProps {
	app: App;
	session: CodexSession | undefined;
	loading: boolean;
	error: string | undefined;
	status: string | undefined;
	isSending: boolean;
	onSend: (prompt: string, images?: string[]) => Promise<void>;
	onStop: () => void;
}

function SessionDetailPane({ app, session, loading, error, status, isSending, onSend, onStop }: SessionDetailPaneProps) {
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
			{session && <div className="codex-history-detail-header"><h2>{session.title || 'Untitled session'}</h2><div className="codex-history-session-meta">{session.id}</div></div>}
			<div ref={messagesRef} className="codex-history-messages">
				{loading ? <div className="codex-history-state">Loading session…</div> : error ? <div className="codex-history-error">{error}</div> : !session ? <div className="codex-history-state">Start a conversation with Codex.</div> : session.messages.length === 0 ? <div className="codex-history-empty">This session has no renderable messages.</div> : session.messages.map((message) => message.role === 'tool'
					? <CollapsedCommand key={message.id} app={app} sessionId={session.id} message={message} />
					: <MarkdownMessage key={message.id} app={app} sessionId={session.id} message={message} />)}
			</div>
			{isSending && status && <div className="codex-history-composer-status"><span className="codex-history-status-indicator" aria-hidden="true" />{status.replace(/^Codex /, '')}</div>}
			<ChatComposer disabled={loading} isSending={isSending} onSend={onSend} onStop={onStop} />
		</div>
	);
}

function ChatComposer({ disabled, isSending, onSend, onStop }: { disabled: boolean; isSending: boolean; onSend: (prompt: string, images?: string[]) => Promise<void>; onStop: () => void }) {
	const [value, setValue] = useState('');
	const [images, setImages] = useState<string[]>([]);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const submit = async (): Promise<void> => {
		const prompt = value.trim();
		if (!prompt || disabled || isSending) return;
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
	return (
		<form className="codex-history-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
			<input ref={fileInputRef} className="codex-history-file-input" type="file" accept="image/*" multiple onChange={selectImages} />
			<IconButton icon="paperclip" label="Attach images" className="codex-history-upload" onClick={() => fileInputRef.current?.click()} disabled={disabled || isSending} />
			<textarea value={value} disabled={disabled || isSending} placeholder="Ask Codex…" rows={3} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
				if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
					event.preventDefault();
					event.currentTarget.form?.requestSubmit();
				}
			}} />
			{isSending ? <IconButton icon="square" label="Stop" className="codex-history-stop" onClick={onStop} /> : <IconButton icon="arrow-up" label="Send" className="codex-history-send" onClick={() => void submit()} disabled={disabled || !value.trim()} />}
			{images.length > 0 && <span className="codex-history-attachment-count">{images.length} image{images.length === 1 ? '' : 's'}</span>}
		</form>
	);
}

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
			void app.workspace.openLinkText(decodeURIComponent(pathPart), '', false);
		};
		body.addEventListener('click', handleLinkClick);
		void MarkdownRenderer.render(app, message.markdown, body, sessionId, component).catch((error: unknown) => setRenderError(toErrorMessage(error)));
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
