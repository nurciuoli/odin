// @vitest-environment node
import { expect, it } from 'vitest'
import { attachmentProblem, messageProblem } from './attachments'
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
