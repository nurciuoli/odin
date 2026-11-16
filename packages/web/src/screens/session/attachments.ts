// Files picked, pasted or dropped on the composer, turned into the API's `Attachment`: images as base64, text files
// as UTF-8. Anything else (and anything over 5 MB) is refused with a reason the screen can show.
import type { Attachment, UserMessage } from '@odin/shared/api'
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_BODY_BYTES,
} from '@odin/shared/messages'

export { MAX_ATTACHMENT_BYTES } from '@odin/shared/messages'

export function attachmentProblem(attachments: Attachment[]): string | null {
  if (attachments.length > MAX_ATTACHMENTS) return `Attach at most ${MAX_ATTACHMENTS} files.`
  const sizes = attachments.map(a =>
    a.mediaType.startsWith('image/')
      ? Math.floor((a.data.length * 3) / 4) -
        (a.data.endsWith('==') ? 2 : a.data.endsWith('=') ? 1 : 0)
      : new TextEncoder().encode(a.data).length,
  )
  if (sizes.some(size => size > MAX_ATTACHMENT_BYTES))
    return 'Each attachment must be at most 5 MB.'
  if (sizes.reduce((total, size) => total + size, 0) > MAX_MESSAGE_ATTACHMENT_BYTES)
    return 'Attachments must total at most 20 MB.'
  return null
}

export function messageProblem(message: UserMessage): string | null {
  return (
    attachmentProblem(message.attachments ?? []) ??
    (new TextEncoder().encode(JSON.stringify(message)).length > MAX_MESSAGE_BODY_BYTES
      ? 'The encoded message is too large. Remove some text or attachments.'
      : null)
  )
}

const TEXT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/javascript',
  'application/typescript',
  'application/x-sh',
  'application/toml',
  'application/sql',
])
const TEXT_EXTENSIONS =
  /\.(txt|md|markdown|json|jsonc|ya?ml|toml|ini|cfg|conf|csv|tsv|log|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|gql|diff|patch|env\.example|gitignore|dockerfile)$/i

export type AttachmentKind = 'image' | 'text'

export function attachmentKind(file: { name: string; type: string }): AttachmentKind | null {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('text/') || TEXT_TYPES.has(file.type)) return 'text'
  if (TEXT_EXTENSIONS.test(file.name) || /^(Dockerfile|Makefile)$/.test(file.name)) return 'text'
  return null
}

function base64(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

export type ReadResult = { ok: true; attachment: Attachment } | { ok: false; reason: string }

export async function readAttachment(file: File): Promise<ReadResult> {
  const kind = attachmentKind(file)
  if (!kind)
    return { ok: false, reason: `${file.name}: only images and text files can be attached` }
  if (file.size > MAX_ATTACHMENT_BYTES)
    return { ok: false, reason: `${file.name} is larger than 5 MB` }
  const mediaType = file.type || (kind === 'text' ? 'text/plain' : 'application/octet-stream')
  const data =
    kind === 'image' ? base64(new Uint8Array(await file.arrayBuffer())) : await file.text()
  return { ok: true, attachment: { name: file.name, mediaType, data } }
}
