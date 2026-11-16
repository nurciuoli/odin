// User message → ACP prompt blocks. Images are raw base64 (png, jpeg, gif, webp) announced by the same
// <attachment> tag Claude uses. Text files are embedded resources. Grok drops a bad image without an error,
// so Odin checks the bytes first and leaves that file out.
import { Buffer } from "node:buffer";
import type { Attachment, UserMessage } from "@odin/shared/api";
import type { Wire } from "./transport.ts";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function imagePromptsAccepted(init: Wire): boolean {
  const caps = init.agentCapabilities?.promptCapabilities;
  if (!caps || typeof caps !== "object") return true;
  return (caps as Wire).image !== false;
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function imageTag(a: Pick<Attachment, "name" | "mediaType">): string {
  return `<attachment name="${escapeAttr(a.name)}" media-type="${escapeAttr(a.mediaType)}" />`;
}

function mediaType(a: Attachment): string {
  const type = a.mediaType.toLowerCase();
  return type === "image/jpg" ? "image/jpeg" : type;
}

function imageBytes(data: string): Buffer | null {
  const compact = data.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return null;
  const bytes = Buffer.from(compact, "base64");
  if (!bytes.length || bytes.toString("base64").replace(/=+$/, "") !== compact.replace(/=+$/, "")) return null;
  return bytes;
}

/** Why this image cannot be sent, or null when the bytes match a format Grok keeps. */
export function imageProblem(a: Attachment): string | null {
  const type = mediaType(a);
  if (!IMAGE_TYPES.has(type)) return `${a.name}: unsupported image format`;
  const bytes = imageBytes(a.data);
  if (!bytes) return `${a.name}: invalid image data`;
  const ok = type === "image/png"
    ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : type === "image/jpeg"
      ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : type === "image/gif"
        ? bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a"
        : bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  return ok ? null : `${a.name}: image data does not match ${type}`;
}

export interface PromptBuild {
  blocks: Wire[];
  /** Images left out, one sentence each. */
  skipped: string[];
}

/** ACP `session/prompt` blocks. `images` is Grok's advertised prompt capability. */
export function promptBlocks(message: UserMessage, images: boolean): PromptBuild {
  const blocks: Wire[] = [];
  const skipped: string[] = [];
  if (message.text) blocks.push({ type: "text", text: message.text });
  for (const a of message.attachments ?? []) {
    if (mediaType(a).startsWith("image/")) {
      if (!images) {
        skipped.push(`${a.name} was not sent. Grok did not advertise image prompts.`);
        continue;
      }
      const problem = imageProblem(a);
      if (problem) {
        skipped.push(`${problem}. It was not sent.`);
        continue;
      }
      blocks.push({ type: "text", text: imageTag(a) });
      blocks.push({ type: "image", data: a.data.replace(/\s/g, ""), mimeType: mediaType(a) });
    } else {
      blocks.push({
        type: "resource",
        resource: {
          uri: `file:///odin-attachment/${encodeURIComponent(a.name)}`,
          mimeType: a.mediaType || "text/plain",
          text: a.data,
        },
      });
    }
  }
  if (!blocks.length) blocks.push({ type: "text", text: message.text });
  return { blocks, skipped };
}
