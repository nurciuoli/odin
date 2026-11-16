import type { UserMessage } from "@odin/shared/api";
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, MAX_MESSAGE_ATTACHMENT_BYTES, MAX_MESSAGE_BODY_BYTES } from "@odin/shared/messages";
import { HttpError } from "../http/util.ts";

/** Transport remains bounded independently of decoded attachment limits (JSON can expand text). */
export const MESSAGE_BODY_MAX_BYTES = MAX_MESSAGE_BODY_BYTES;
export const MESSAGE_TEXT_MAX_BYTES = 1024 * 1024;

function bad(text: string): never { throw new HttpError(400, text); }

export function validateMessage(message: unknown): UserMessage {
  const m = message as UserMessage | null;
  if (!m || typeof m !== "object" || typeof m.text !== "string") bad("a message needs text");
  if (Buffer.byteLength(m.text, "utf8") > MESSAGE_TEXT_MAX_BYTES) bad("message text exceeds 1 MiB");
  if (/^\s*\/(clear|reset|new)(\s|$)/.test(m.text)) bad("/clear isn't sent to the agent: start a new session instead");
  if (m.clientId !== undefined && (typeof m.clientId !== "string" || !m.clientId.trim() || m.clientId.length > 200)) bad("invalid message clientId");
  if (m.attachments !== undefined) {
    if (!Array.isArray(m.attachments)) bad("attachments must be a list");
    if (m.attachments.length > MAX_ATTACHMENTS) bad(`a message can have at most ${MAX_ATTACHMENTS} attachments`);
    let total = 0;
    for (const a of m.attachments) {
      if (!a || typeof a.name !== "string" || typeof a.mediaType !== "string" || typeof a.data !== "string") bad("invalid attachment");
      const image = a.mediaType.startsWith("image/");
      if (image && Buffer.from(a.data, "base64").toString("base64") !== a.data) bad("image attachment must be base64");
      const bytes = Buffer.byteLength(a.data, image ? "base64" : "utf8");
      if (bytes > MAX_ATTACHMENT_BYTES) bad("attachment exceeds 5 MiB");
      total += bytes;
    }
    if (total > MAX_MESSAGE_ATTACHMENT_BYTES) bad("message attachments exceed 20 MiB in total");
  }
  if (!m.text.trim() && !m.attachments?.length) bad("a message needs text");
  return { text: m.text, ...(m.attachments?.length ? { attachments: m.attachments.map(a => ({ name: a.name, mediaType: a.mediaType, data: a.data })) } : {}), ...(m.clientId ? { clientId: m.clientId } : {}) };
}
