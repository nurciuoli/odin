// Managed instruction fragments preserve every byte outside Odin's own section.
export function instructionFragment(text: string, id: string): { body: string; start: number; end: number } | null {
  const open = `<!-- odin:${id}:start -->\n`;
  const close = `<!-- odin:${id}:end -->`;
  const normalized = text.replace(/\r\n/g, "\n");
  const start = normalized.indexOf(open);
  const end = normalized.indexOf(close);
  if (start < 0 && end < 0) return null;
  if (start < 0 || end < start || normalized.indexOf(open, start + open.length) >= 0 || normalized.indexOf(close, end + close.length) >= 0)
    throw new Error(`AGENTS.md has malformed or duplicate Odin markers for ${id}`);
  return { body: normalized.slice(start + open.length, end), start, end: end + close.length };
}

export function setInstruction(text: string, id: string, body: string | null): string {
  // Keep original offsets and line endings outside the managed fragment.
  const fragment = instructionFragment(text, id);
  const block = body === null ? "" : `<!-- odin:${id}:start -->\n${body.trimEnd()}\n<!-- odin:${id}:end -->`;
  if (!fragment) return block ? `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n` : text;
  const open = text.indexOf(`<!-- odin:${id}:start -->`);
  const close = text.indexOf(`<!-- odin:${id}:end -->`, open) + `<!-- odin:${id}:end -->`.length;
  return text.slice(0, open) + block + text.slice(close);
}
