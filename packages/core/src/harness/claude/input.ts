// Streaming input for one live query: an async queue of SDKUserMessage, and the UserMessage → SDKUserMessage mapping.
// Attachments: images go as base64 image blocks (announced by a small tag so the model and the history keep the file
// name), everything else is utf-8 text inlined in an <attachment> block. history.ts reads both back.
import { EventQueue } from "../queue.ts";
import type { UUID } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Attachment, UserMessage } from "@odin/shared/api";

/** An async queue with one consumer; `end()` finishes the iteration once the queue is drained. */
export class InputQueue<T> extends EventQueue<T> {
  override [Symbol.asyncIterator](): AsyncIterator<T> {
    const iterator = super[Symbol.asyncIterator]();
    return { ...iterator, return: () => { this.end(); return Promise.resolve({ value: undefined, done: true }); } };
  }
}

type ContentBlock = Exclude<SDKUserMessage["message"]["content"], string>[number];
type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const isImage = (a: Pick<Attachment, "mediaType">) => a.mediaType.toLowerCase().startsWith("image/");

/** The tag that announces an image attachment (followed by the image block). */
export function imageTag(a: Pick<Attachment, "name" | "mediaType">): string {
  return `<attachment name="${escapeAttr(a.name)}" media-type="${escapeAttr(a.mediaType)}" />`;
}

/** A text attachment inlined as a text block. */
export function textAttachment(a: Attachment): string {
  return `<attachment name="${escapeAttr(a.name)}" media-type="${escapeAttr(a.mediaType)}">\n${a.data}\n</attachment>`;
}

/** The content sent for a user message: a plain string without attachments, else blocks. */
export function userContent(message: UserMessage): SDKUserMessage["message"]["content"] {
  const attachments = message.attachments ?? [];
  if (!attachments.length) return message.text;
  const blocks: ContentBlock[] = [];
  if (message.text) blocks.push({ type: "text", text: message.text });
  for (const a of attachments) {
    if (isImage(a)) {
      blocks.push({ type: "text", text: imageTag(a) });
      blocks.push({ type: "image", source: { type: "base64", media_type: a.mediaType.toLowerCase() as ImageMediaType, data: a.data } });
    } else {
      blocks.push({ type: "text", text: textAttachment(a) });
    }
  }
  return blocks;
}

export function toSdkUserMessage(message: UserMessage, uuid: UUID): SDKUserMessage {
  return { type: "user", message: { role: "user", content: userContent(message) }, parent_tool_use_id: null, uuid };
}
