const DIFF_LINE_PATTERN = /^(?:\+\+\+|---|@@|\+|-|diff --git|index |new file mode|deleted file mode)/;

export function normalizeToolMarkdown(markdown: string, toolName: string | undefined): string {
	if (!toolName || !/^(?:exec|shell command)$/i.test(toolName)) return markdown;
	const resultMarker = /(^|\n)(\*\*Result\*\*\n\n)([\s\S]*)$/m.exec(markdown);
	const resultText = resultMarker?.[3];
	const prefix = resultMarker?.[1];
	const marker = resultMarker?.[2];
	if (!resultMarker || !prefix || !marker || !resultText || !looksLikeDiff(resultText)) return markdown;
	const result = resultText.replace(/^```(?:diff|patch)?\n([\s\S]*?)\n```$/i, '$1');
	return `${markdown.slice(0, resultMarker.index + prefix.length + marker.length)}\`\`\`diff\n${result}\n\`\`\``;
}

export function decorateDiffBlocks(root: HTMLElement): void {
	for (const code of Array.from(root.querySelectorAll<HTMLElement>('pre code'))) {
		if (!/language-(?:diff|patch)\b/i.test(code.className)) continue;
		const lines = code.textContent?.split('\n') ?? [];
		code.replaceChildren(...lines.map((line, index) => {
			const element = document.createElement('span');
			element.className = `codex-history-diff-line ${diffLineClass(line)}`;
			element.textContent = line || ' ';
			if (index < lines.length - 1) element.append(document.createTextNode('\n'));
			return element;
		}));
	}
}

function looksLikeDiff(value: string): boolean {
	const lines = value.split('\n');
	return lines.filter((line) => DIFF_LINE_PATTERN.test(line)).length >= 2 && lines.some((line) => line.startsWith('@@') || line.startsWith('diff --git'));
}

function diffLineClass(line: string): string {
	if (line.startsWith('+++') || line.startsWith('---')) return 'codex-history-diff-file';
	if (line.startsWith('+')) return 'codex-history-diff-add';
	if (line.startsWith('-')) return 'codex-history-diff-remove';
	if (line.startsWith('@@')) return 'codex-history-diff-hunk';
	return '';
}
