/**
 * Normalize display-math delimiters that are not handled consistently by
 * every Obsidian/MathJax version.
 *
 * Keep fenced code blocks untouched: a code sample containing `\[ ... \]`
 * must remain a code sample rather than becoming rendered mathematics.
 */
export function normalizeMathDelimiters(markdown: string): string {
	const parts = markdown.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g);
	return parts.map((part, index) => {
		if (index % 2 === 1) return part;
		return part.replace(/\\\[([\s\S]*?)\\\]/g, (_, expression: string) => `$$${expression}$$`);
	}).join('');
}
