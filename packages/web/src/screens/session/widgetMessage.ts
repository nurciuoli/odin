import type { NotebookComm } from '@odin/shared/notebooks'
export const WIDGET_MESSAGE_MAX_BYTES = 1024 * 1024
export type WidgetFrameMessage =
  | { type: 'odin.widget.ready'; kernelId: string; modelId: string }
  | {
      type: 'odin.widget.comm'
      kernelId: string
      modelId: string
      requestId: string
      message: NotebookComm
    }
/** Sandboxed frames have null origins. Trust the window identity and bounded protocol instead. */
export function acceptWidgetMessage(
  event: Pick<MessageEvent, 'source' | 'data'>,
  source: Window | null,
  kernelId: string,
  modelId: string,
): WidgetFrameMessage | null {
  if (!source || event.source !== source || !event.data || typeof event.data !== 'object')
    return null
  const value = event.data as Record<string, unknown>
  if (value.kernelId !== kernelId || value.modelId !== modelId) return null
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > WIDGET_MESSAGE_MAX_BYTES)
      return null
  } catch {
    return null
  }
  if (value.type === 'odin.widget.ready') return value as WidgetFrameMessage
  if (
    value.type !== 'odin.widget.comm' ||
    typeof value.requestId !== 'string' ||
    value.requestId.length > 100
  )
    return null
  const message = value.message as NotebookComm | undefined
  if (
    !message ||
    !['comm_msg', 'comm_close'].includes(message.type) ||
    typeof message.commId !== 'string' ||
    message.commId.length > 100 ||
    !message.data ||
    typeof message.data !== 'object' ||
    Array.isArray(message.data)
  )
    return null
  if (
    message.buffers &&
    (!Array.isArray(message.buffers) ||
      message.buffers.some(b => typeof b !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b)))
  )
    return null
  return value as WidgetFrameMessage
}
