/** Runs only inside the opaque-origin widget iframe. Never imports the app/API client. */
import { ManagerBase } from '@jupyter-widgets/base-manager'
import * as base from '@jupyter-widgets/base'
import * as controls from '@jupyter-widgets/controls'
import type { ICallbacks, IClassicComm } from '@jupyter-widgets/base'
import type { NotebookComm } from '@odin/shared/notebooks'
import widgetCss from '@jupyter-widgets/controls/css/widgets.built.css?inline'
import variableCss from '@jupyter-widgets/controls/css/labvariables.css?inline'

const root = document.getElementById('odin-widget-root')!
const segments = location.pathname.split('/').map(decodeURIComponent)
const kernelId = segments[3]
const modelId = segments[4]
const comms = new Map<string, Comm>()
const acknowledgements = new Map<string, ICallbacks | undefined>()
type Data = Parameters<IClassicComm['send']>[0]
type Buffers = Parameters<IClassicComm['send']>[3]
function encodeBuffers(buffers: Buffers): string[] | undefined {
  return buffers?.map(buffer => {
    const bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer)
    if (bytes.byteLength > 512 * 1024) throw new Error('Widget binary message exceeds the limit')
    let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 8192)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
    return btoa(binary)
  })
}
function send(message: NotebookComm, callbacks?: ICallbacks) {
  const requestId = crypto.randomUUID()
  const envelope = { type: 'odin.widget.comm', kernelId, modelId, requestId, message }
  if (new TextEncoder().encode(JSON.stringify(envelope)).length > 1024 * 1024)
    throw new Error('Widget message exceeds the limit')
  acknowledgements.set(requestId, callbacks)
  window.parent.postMessage(envelope, '*')
  return requestId
}
class Comm implements IClassicComm {
  comm_id: string
  target_name: string
  onMessage?: Parameters<IClassicComm['on_msg']>[0]
  onClose?: Parameters<IClassicComm['on_close']>[0]
  constructor(id: string, target = 'jupyter.widget') {
    this.comm_id = id
    this.target_name = target
    comms.set(id, this)
  }
  open(
    data: Data,
    callbacks?: ICallbacks,
    _metadata?: Parameters<IClassicComm['open']>[2],
    buffers?: Buffers,
  ) {
    return send(
      {
        type: 'comm_open',
        commId: this.comm_id,
        targetName: this.target_name,
        data: data as Record<string, unknown>,
        buffers: encodeBuffers(buffers),
      },
      callbacks,
    )
  }
  send(
    data: Data,
    callbacks?: ICallbacks,
    _metadata?: Parameters<IClassicComm['send']>[2],
    buffers?: Buffers,
  ) {
    return send(
      {
        type: 'comm_msg',
        commId: this.comm_id,
        data: data as Record<string, unknown>,
        buffers: encodeBuffers(buffers),
      },
      callbacks,
    )
  }
  close(data?: Data, callbacks?: ICallbacks) {
    return send(
      { type: 'comm_close', commId: this.comm_id, data: (data ?? {}) as Record<string, unknown> },
      callbacks,
    )
  }
  on_msg(callback: Parameters<IClassicComm['on_msg']>[0]) {
    this.onMessage = callback
  }
  on_close(callback: Parameters<IClassicComm['on_close']>[0]) {
    this.onClose = callback
  }
}
class WidgetManager extends ManagerBase {
  async loadClass(name: string, module: string) {
    const exports =
      module === '@jupyter-widgets/base'
        ? base
        : module === '@jupyter-widgets/controls'
          ? controls
          : null
    const value = exports && (exports as unknown as Record<string, unknown>)[name]
    if (typeof value !== 'function')
      throw new Error(
        `Widget module ${module} is not bundled. Only standard ipywidgets controls are supported.`,
      )
    return value as typeof base.WidgetModel | typeof base.WidgetView
  }
  async _get_comm_info() {
    return Object.fromEntries([...comms.keys()].map(id => [id, { target_name: 'jupyter.widget' }]))
  }
  async _create_comm(
    target: string,
    id = crypto.randomUUID(),
    data?: Data,
    metadata?: Parameters<IClassicComm['open']>[2],
    buffers?: Buffers,
  ) {
    const comm = comms.get(id) ?? new Comm(id, target)
    if (data) comm.open(data, undefined, metadata, buffers)
    return comm
  }
}
const manager = new WidgetManager()
const style = document.createElement('style')
style.textContent = variableCss + '\n' + widgetCss
document.head.appendChild(style)
function wireMessage(message: NotebookComm) {
  return {
    channel: 'iopub',
    header: {
      msg_type: message.type,
      msg_id: crypto.randomUUID(),
      username: '',
      session: '',
      date: new Date().toISOString(),
      version: '5.3',
    },
    parent_header: {},
    metadata: { version: '2.1.0' },
    content: {
      comm_id: message.commId,
      target_name: message.targetName ?? 'jupyter.widget',
      data: message.data,
    },
    buffers: (message.buffers ?? []).map(
      value => Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer,
    ),
  }
}
async function apply(message: NotebookComm) {
  const wire = wireMessage(message)
  if (message.type === 'comm_open') {
    if (manager.has_model(message.commId)) return
    const comm = comms.get(message.commId) ?? new Comm(message.commId, message.targetName)
    await manager.handle_comm_open(
      comm,
      wire as unknown as Parameters<ManagerBase['handle_comm_open']>[1],
    )
  } else if (message.type === 'comm_close') {
    comms.get(message.commId)?.onClose?.(wire)
    comms.delete(message.commId)
  } else comms.get(message.commId)?.onMessage?.(wire)
}
let initialized = false
const waiting: NotebookComm[] = []
let chain = Promise.resolve()
window.addEventListener('message', event => {
  if (
    event.source !== window.parent ||
    event.data?.kernelId !== kernelId ||
    event.data?.modelId !== modelId
  )
    return
  const value = event.data
  if (value.type === 'odin.widget.ack') {
    const callbacks = acknowledgements.get(value.requestId)
    acknowledgements.delete(value.requestId)
    callbacks?.iopub?.status?.({ content: { execution_state: 'idle' } } as Parameters<
      NonNullable<ICallbacks['iopub']>['status']
    >[0])
    if (value.error) root.textContent = 'Widget callback failed. Check the notebook kernel.'
    return
  }
  chain = chain
    .then(async () => {
      if (value.type === 'odin.widget.init' && !initialized) {
        const state = value.state as NotebookComm[]
        // Register every model before waiting, so references between widgets resolve.
        await Promise.all(state.filter(message => message.type === 'comm_open').map(apply))
        initialized = true
        for (const message of waiting.splice(0)) await apply(message)
        const model = await manager.get_model(modelId)
        const view = await manager.create_view(model)
        root.textContent = ''
        base.JupyterLuminoWidget.attach(view.luminoWidget, root)
      } else if (value.type === 'odin.widget.receive') {
        if (initialized) await apply(value.message)
        else if (waiting.length < 100) waiting.push(value.message)
      }
    })
    .catch(error => {
      root.textContent = error instanceof Error ? error.message : 'Widget could not be rendered'
    })
})
window.parent.postMessage({ type: 'odin.widget.ready', kernelId, modelId }, '*')
