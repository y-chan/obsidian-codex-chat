import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef, type FormEvent, type ReactNode } from 'react';
import { App, Component, MarkdownRenderer, setIcon } from 'obsidian';
import type { CodexMessage, CodexSession, CodexSessionSummary } from '../types/codex';
import { filterSessionSummaries } from '../parsers/CodexHistoryParser';
import { CodexHistoryService } from '../services/CodexHistoryService';
import { WorkingDirectoryService } from '../services/WorkingDirectoryService';

export interface CodexHistoryAppHandle {
	reload: () => Promise<void>;
	setWorkingDirectory: (value: string) => Promise<void>;
}

interface CodexHistoryAppProps {
	app: App;
	historyService: CodexHistoryService;
	workingDirectoryService: WorkingDirectoryService;
	initialWorkingDirectory: string | undefined;
}

export const CodexHistoryApp = forwardRef<CodexHistoryAppHandle, CodexHistoryAppProps>(function CodexHistoryApp(
	{ app, historyService, workingDirectoryService, initialWorkingDirectory },
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
			if (generation === sessionGeneration.current) setSelectedSession(session);
		} catch (sessionError) {
			if (generation === sessionGeneration.current) setError(toErrorMessage(sessionError));
		} finally {
			if (generation === sessionGeneration.current) setIsLoadingSession(false);
		}
	}, [historyService, workingDirectory]);

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
			{status && !error && <div className="codex-history-status">{status}</div>}
			<div className="codex-history-content">
				<IconButton icon="list" label={isSessionListOpen ? 'Hide sessions' : 'Show sessions'} className="codex-history-session-toggle" onClick={() => setIsSessionListOpen((open) => !open)} />
				<div className="codex-history-split">
					{isSessionListOpen && <div aria-hidden="true" className="codex-history-list-backdrop" onClick={() => setIsSessionListOpen(false)} />}
					<SessionListPane open={isSessionListOpen} sessions={sessions} selectedId={selectedSessionId} query={searchQuery} onSearch={setSearchQuery} onSelect={(id) => { setIsSessionListOpen(false); void selectSession(id); }} />
				<SessionDetailPane app={app} session={selectedSession} loading={isLoadingSession} error={selectedSessionId && !isLoadingSession && !selectedSession ? error : undefined} />
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

	return (
		<div className="codex-history-working-directory">
			<form onSubmit={submit}>
				<label>
					Working directory
					<input type="text" value={value} placeholder="Absolute path" onChange={(event) => setValue(event.target.value)} onBlur={() => void commit(value)} />
				</label>
			</form>
			<div className="codex-history-directory-actions">
				<IconButton icon="folder-open" label="Use vault root" onClick={() => usePath(service.getVaultRoot())} />
				<IconButton icon="file-directory" label="Use current file directory" onClick={() => usePath(service.getCurrentFileDirectory())} />
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
}

function SessionDetailPane({ app, session, loading, error }: SessionDetailPaneProps) {
	if (loading) return <div className="codex-history-detail-pane"><div className="codex-history-state">Loading session…</div></div>;
	if (error) return <div className="codex-history-detail-pane"><div className="codex-history-error">{error}</div></div>;
	if (!session) return <div className="codex-history-detail-pane"><div className="codex-history-state">Select a session.</div></div>;
	return (
		<div className="codex-history-detail-pane">
			<div className="codex-history-detail-header"><h2>{session.title || 'Untitled session'}</h2><div className="codex-history-session-meta">{session.id}</div></div>
			<div className="codex-history-messages">
				{session.messages.length === 0 ? <div className="codex-history-empty">This session has no renderable messages.</div> : session.messages.map((message) => message.role === 'tool'
					? <CollapsedCommand key={message.id} app={app} sessionId={session.id} message={message} />
					: <MarkdownMessage key={message.id} app={app} sessionId={session.id} message={message} />)}
			</div>
		</div>
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
		void MarkdownRenderer.render(app, message.markdown, body, sessionId, component).catch((error: unknown) => setRenderError(toErrorMessage(error)));
		return () => {
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
