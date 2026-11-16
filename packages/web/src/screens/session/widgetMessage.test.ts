// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { acceptWidgetMessage } from './widgetMessage'
describe('widget message boundary', () => {
  const frame = {} as Window
  const message = {
    type: 'odin.widget.comm',
    kernelId: 'k',
    modelId: 'm',
    requestId: '1',
    message: { type: 'comm_msg', commId: 'm', data: { method: 'update', state: { value: 7 } } },
  }
  it('requires the exact frame window and resource identity', () => {
    expect(acceptWidgetMessage({ source: frame, data: message }, frame, 'k', 'm')).toEqual(message)
    expect(acceptWidgetMessage({ source: {} as Window, data: message }, frame, 'k', 'm')).toBeNull()
    expect(acceptWidgetMessage({ source: frame, data: message }, frame, 'other', 'm')).toBeNull()
    expect(acceptWidgetMessage({ source: frame, data: message }, frame, 'k', 'other')).toBeNull()
  })
  it('rejects unknown commands, model creation, oversized messages and invalid binary buffers', () => {
    for (const data of [
      { ...message, type: 'execute' },
      { ...message, message: { ...message.message, type: 'comm_open' } },
      { ...message, message: { ...message.message, data: { x: 'a'.repeat(1024 * 1024) } } },
      { ...message, message: { ...message.message, buffers: ['not base64!'] } },
    ])
      expect(acceptWidgetMessage({ source: frame, data }, frame, 'k', 'm')).toBeNull()
  })
})
