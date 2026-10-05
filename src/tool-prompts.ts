// Pi's <tools> and <rules> sections sit beside its preamble, which the bridge must not
// forward, so each tool's snippet and guidelines ride in that tool's description instead.

export type ToolPrompt = { snippet?: string; guidelines: string[] };

export type ToolPrompts = Record<string, ToolPrompt>;

export function toolPromptsFrom(
	snippets: Record<string, string> | undefined,
	guidelines: Record<string, readonly string[]> | undefined,
): ToolPrompts {
	const prompts: ToolPrompts = {};
	for (const name of new Set([...Object.keys(snippets ?? {}), ...Object.keys(guidelines ?? {})])) {
		const snippet = snippets?.[name]?.trim();
		const rules = (guidelines?.[name] ?? []).map((rule) => rule.trim()).filter(Boolean);
		if (!snippet && rules.length === 0) continue;
		prompts[name] = { ...(snippet ? { snippet } : {}), guidelines: rules };
	}
	return prompts;
}

export function describeTool(description: string, prompt: ToolPrompt | undefined): string {
	if (!prompt) return description;
	const parts: string[] = [];
	if (prompt.snippet && !description.includes(prompt.snippet)) parts.push(prompt.snippet);
	parts.push(description);
	if (prompt.guidelines.length > 0) {
		parts.push(["Guidelines:", ...prompt.guidelines.map((rule) => `- ${rule}`)].join("\n"));
	}
	return parts.join("\n\n");
}
