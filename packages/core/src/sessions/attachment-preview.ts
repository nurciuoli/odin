// Turn stored attachment bytes into a response the browser can show. Images are the four formats the
// composers accept. Everything else is served as plain text so HTML and SVG cannot run as a page.
import type { AttachmentContent } from "../harness/types.ts";

const MAX_BYTES = 5 * 1024 * 1024;
const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface AttachmentPreview {
  mediaType: string;
  disposition: string;
  body: Buffer;
}

function filenameOf(name: string): { ascii: string; encoded: string } {
  const cleaned = name.replace(/[\r\n"]/g, "").trim().slice(0, 180) || "attachment";
  const ascii = cleaned.replace(/[^\x20-\x7E]/g, "_");
  return { ascii: ascii || "attachment", encoded: encodeURIComponent(cleaned) };
}

/** Null when the bytes are empty, too large, or not valid for their encoding. */
export function attachmentPreview(file: AttachmentContent): AttachmentPreview | null {
  const type = file.mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  const imageType = type === "image/jpg" ? "image/jpeg" : type;
  let body: Buffer;
  if (file.encoding === "base64") {
    const data = file.data.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
    body = Buffer.from(data, "base64");
  } else {
    body = Buffer.from(file.data, "utf8");
  }
  if (!body.length || body.length > MAX_BYTES) return null;
  const names = filenameOf(file.name);
  const disposition = `inline; filename="${names.ascii}"; filename*=UTF-8''${names.encoded}`;
  if (file.encoding === "base64" && IMAGES.has(imageType)) {
    return { mediaType: imageType, disposition, body };
  }
  if (file.encoding === "base64") return null;
  return { mediaType: "text/plain; charset=utf-8", disposition, body };
}
