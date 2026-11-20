// @vitest-environment node
import { expect, it } from 'vitest'
import {
  attachmentProblem,
  chatAttachment,
  messageProblem,
  transcriptAttachment,
} from './attachments'
import {
  MAX_ATTACHMENTS,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_BODY_BYTES,
} from '@odin/shared/messages'

const attachment = (data = 'x') => ({ name: 'text.txt', mediaType: 'text/plain', data })
it('enforces count, decoded aggregate bytes, and encoded body limits separately', () => {
  expect(
    attachmentProblem(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => attachment())),
  ).toContain('10')
  const chunk = 'x'.repeat(MAX_MESSAGE_ATTACHMENT_BYTES / 4)
  expect(attachmentProblem(Array.from({ length: 4 }, () => attachment(chunk)))).toBeNull()
  expect(
    attachmentProblem([...Array.from({ length: 4 }, () => attachment(chunk)), attachment()]),
  ).toContain('20 MB')
  expect(
    messageProblem({ text: '\u0000'.repeat(Math.ceil(MAX_MESSAGE_BODY_BYTES / 6)) }),
  ).toContain('encoded')
})

it('keeps image bytes on a composer chip and points a transcript chip at the preview route', () => {
  expect(
    chatAttachment(
      '1',
      { name: 'a.png', size: 4 },
      { name: 'a.png', mediaType: 'image/png', data: 'AAAA' },
    ),
  ).toMatchObject({
    kind: 'image',
    src: 'data:image/png;base64,AAAA',
  })
  expect(
    chatAttachment(
      '2',
      { name: 'a.md' },
      { name: 'a.md', mediaType: 'text/markdown', data: '# a' },
    ),
  ).toMatchObject({
    kind: 'file',
    text: '# a',
  })
  expect(transcriptAttachment('s 1', 'u/1', 0, { name: 'a.png', mediaType: 'image/png' }).src).toBe(
    '/api/sessions/s%201/attachments/u%2F1/0',
  )
  expect(
    transcriptAttachment('s', 'u', 1, { name: 'a.md', mediaType: 'text/markdown' }).previewUrl,
  ).toBe('/api/sessions/s/attachments/u/1')
})
