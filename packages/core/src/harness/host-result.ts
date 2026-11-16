import type { HostToolContent, HostToolResult } from "./types.ts";

/** Keep results comfortably below the shared MCP bridge's 8 MiB JSON-frame limit. */
export const HOST_RESULT_TEXT_BYTES = 64 * 1024;
export const HOST_RESULT_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_BLOCKS = 32;
const OMITTED = "\n[Output truncated; use the notebook viewer for the full output.]";

/** Best effort for obvious credentials. This is not a security boundary for arbitrary Python output. */
export function scrubHostText(text: string): string {
  return text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]")
    .replace(/\b((?:ODIN_[A-Z_]*(?:TOKEN|SECRET)|GITHUB_TOKEN|GH_TOKEN|[A-Z_]*(?:API_KEY|ACCESS_TOKEN))\s*[=:]\s*)[^\s,;"']+/g, "$1[redacted]");
}

function boundedText(text: string, bytes: number): string {
  const safe = scrubHostText(text);
  if (Buffer.byteLength(safe) <= bytes) return safe;
  // Decode only complete code points; the replacement character is harmless but avoid its extra bytes.
  return Buffer.from(safe).subarray(0, Math.max(0, bytes - Buffer.byteLength(OMITTED)))
    .toString("utf8").replace(/\uFFFD$/, "") + OMITTED;
}

export function boundHostToolResult(result: HostToolResult): HostToolResult {
  const text = boundedText(typeof result?.text === "string" ? result.text : "", HOST_RESULT_TEXT_BYTES);
  let textBytes = Buffer.byteLength(text);
  let imageBytes = 0;
  const content: HostToolContent[] = [];
  let omitted = false;
  for (const block of Array.isArray(result?.content) ? result.content : []) {
    if (content.length >= MAX_BLOCKS) { omitted = true; break; }
    if (block?.type === "text" && typeof block.text === "string") {
      const remaining = HOST_RESULT_TEXT_BYTES - textBytes;
      if (remaining < Buffer.byteLength(OMITTED)) { omitted = true; continue; }
      const value = boundedText(block.text, remaining);
      textBytes += Buffer.byteLength(value);
      content.push({ type: "text", text: value });
    } else if (block?.type === "image" && (block.mimeType === "image/png" || block.mimeType === "image/jpeg") &&
        typeof block.data === "string" && block.data.length > 0 && block.data.length % 4 === 0 &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(block.data) && imageBytes + block.data.length <= HOST_RESULT_IMAGE_BYTES) {
      imageBytes += block.data.length;
      content.push({ type: "image", mimeType: block.mimeType, data: block.data });
    } else omitted = true;
  }
  // The fixed-size note is bounded independently so truncation is always visible.
  const summary = omitted ? text + "\n[Additional output omitted: size limit or unsupported content.]" : text;
  return { text: summary, ...(content.length ? { content } : {}), ...(result?.isError ? { isError: true } : {}) };
}

export function mcpHostContent(result: HostToolResult) {
  const safe = boundHostToolResult(result);
  return [
    { type: "text" as const, text: safe.text },
    ...(safe.content ?? []).map(block => block.type === "image"
      ? { type: "image" as const, mimeType: block.mimeType, data: block.data }
      : { type: "text" as const, text: block.text }),
  ];
}

/** Transcript format is text-only; never insert base64 image bytes into transcript prose. */
export function hostResultSummary(result: HostToolResult): string {
  const safe = boundHostToolResult(result);
  return [safe.text, ...(safe.content ?? []).map(block => block.type === "text" ? block.text : `[Image: ${block.mimeType}; see notebook output]`)].join("\n");
}
