// Rough token estimator: ~4 chars per token for English text.
// Good enough for Claude Code's context-budget pre-flight checks.

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'tool_use') return JSON.stringify(b.input || {});
      if (b.type === 'tool_result') {
        return Array.isArray(b.content)
          ? b.content.map((c) => c.text || '').join('\n')
          : String(b.content ?? '');
      }
      return '';
    })
    .join('\n');
}

export function estimateTokens(req) {
  let chars = 0;

  if (req.system) {
    chars += Array.isArray(req.system)
      ? req.system.map((b) => b.text || '').join('').length
      : String(req.system).length;
  }

  for (const m of req.messages || []) chars += textOf(m.content).length;

  for (const t of req.tools || []) {
    chars += (t.name || '').length;
    chars += (t.description || '').length;
    chars += JSON.stringify(t.input_schema || {}).length;
  }

  return Math.ceil(chars / 4);
}
