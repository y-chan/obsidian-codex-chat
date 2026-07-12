export class Logger {
	constructor(private readonly enabled: boolean) {}

	info(message: string, details?: unknown): void {
		if (!this.enabled) return;
		console.warn(`[Codex History] ${message}`, details ?? '');
	}

	debug(message: string, details?: unknown): void {
		if (!this.enabled) return;
		console.debug(`[Codex History] ${message}`, details ?? '');
	}

	warn(message: string, details?: unknown): void {
		console.warn(`[Codex History] ${message}`, details ?? '');
	}
}
