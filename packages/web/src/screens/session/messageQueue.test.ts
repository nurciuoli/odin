import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { API_KEY } from '@/api'
import { useCommands } from '@/app/commands'
import { createMockApi, type MockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createAppRouter } from '@/app/router'
import { resetDrafts, useDrafts } from '@/app/drafts'
import SessionScreen from './SessionScreen.vue'
import { completeMessageAttempt, messageAttempt, unresolvedMessages } from './sendAttempt'

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  localStorage.clear()
  sessionStorage.clear()
  unresolvedMessages.value = []
  resetDrafts()
})
async function open(api: MockApi, id = FIXTURE_SESSION_IDS.running) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(`/s/${id}`)
  wrapper = mount(SessionScreen, {
    props: { id },
    attachTo: document.body,
    global: { plugins: [router], provide: { [API_KEY as symbol]: api } },
  })
  await flushPromises()
}
const click = async (label: string) => {
  const button = wrapper!.findAll('button').find(b => b.text().trim() === label)
  expect(button, label).toBeDefined()
  await button!.trigger('click')
  await flushPromises()
}

describe('message queue', () => {
  it('keeps keyboard hint stable while focus transfers from the textarea to Send', async () => {
    await open(createMockApi())
    const textarea = wrapper!.find('textarea[aria-label="Message"]')
    await textarea.setValue('Send at narrow width')
    const send = wrapper!.find('button[aria-label="Send"]')
    await textarea.trigger('focusin')
    const hint = wrapper!.find('.iu-composer__hint').text()
    await textarea.trigger('focusout', { relatedTarget: send.element })
    expect(wrapper!.find('.iu-composer__hint').text()).toBe(hint)
    expect(hint).toContain('send')
  })

  it('refreshes Grok native history at completion without inventing user transcript ids', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    api.db.sessions.find(session => session.id === id)!.harness = 'grok'
    await open(api)
    const getSession = vi.spyOn(api, 'getSession')
    api.db.transcripts[id]!.push({
      kind: 'user',
      id: 'native-grok-user',
      text: 'Delivered Grok follow-up',
      at: new Date().toISOString(),
      parentToolUseId: null,
    })
    expect(wrapper!.text()).not.toContain('Delivered Grok follow-up')
    api.harnessEvent(id, { type: 'turn.end', ok: true, error: null, durationMs: 1 })
    api.harnessEvent(id, { type: 'state', state: 'idle' })
    await flushPromises()
    expect(getSession).toHaveBeenCalledWith(id)
    expect(wrapper!.text()).toContain('Delivered Grok follow-up')
  })

  it('refreshes OpenCode history after compaction replaces the native transcript', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    api.db.sessions.find(session => session.id === id)!.harness = 'opencode'
    await open(api)
    const getSession = vi.spyOn(api, 'getSession')
    api.db.transcripts[id] = [
      {
        kind: 'user',
        id: 'compacted-user',
        text: 'Compacted OpenCode history',
        at: new Date().toISOString(),
        parentToolUseId: null,
      },
    ]
    api.harnessEvent(id, { type: 'turn.end', ok: true, error: null, durationMs: 1 })
    await flushPromises()
    expect(getSession).toHaveBeenCalledWith(id)
    expect(wrapper!.text()).toContain('Compacted OpenCode history')
  })

  it('keeps a mid-turn message visible through pause and remount, then resumes explicitly', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    await open(api)
    await wrapper!.find('textarea[aria-label="Message"]').setValue('Check the queue')
    await wrapper!.find('button[aria-label="Send"]').trigger('click')
    await flushPromises()
    expect(wrapper!.find('[aria-label="Message queue"]').text()).toContain('Check the queue')
    expect((await api.queue(id)).messages[0]?.state).toBe('queued')
    await api.interruptSession(id)
    await flushPromises()
    expect(wrapper!.find('[aria-label="Message queue"]').text()).toContain('Queue paused')
    wrapper!.unmount()
    await open(api)
    expect(wrapper!.find('[aria-label="Message queue"]').text()).toContain('Check the queue')
    await click('Resume queue')
    expect((await api.queue(id)).messages[0]?.state).toBe('sending')
    expect(wrapper!.find('[aria-label="Message queue"]').exists()).toBe(false)
  })

  it('edits text without stripping attachments and cancels queued work', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    const attachment = { name: 'note.txt', mediaType: 'text/plain', data: 'hi' }
    await api.sendMessage(id, { text: 'Original', attachments: [attachment] })
    await open(api)
    await click('Edit')
    await wrapper!.find('.message-queue textarea').setValue('Updated')
    await click('Save message')
    expect((await api.queue(id)).messages[0]?.message).toMatchObject({
      text: 'Updated',
      attachments: [attachment],
    })
    await click('Cancel message')
    expect((await api.queue(id)).messages).toEqual([])
    expect(wrapper!.find('[aria-label="Message queue"]').exists()).toBe(false)
  })

  it('explains uncertain delivery and requires explicit retry and resume', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.idle
    await api.sendMessage(id, { text: 'Maybe accepted' })
    api.harnessEvent(id, { type: 'exit', outcome: 'failed', error: 'Disconnected' })
    await open(api, id)
    expect(wrapper!.find('.message-queue').text()).toContain('Delivery uncertain')
    expect(
      wrapper!
        .findAll('button')
        .find(b => b.text() === 'Resume queue')!
        .attributes('disabled'),
    ).toBeDefined()
    await click('Retry message…')
    expect(wrapper!.find('.message-queue').text()).toContain('may repeat its actions')
    await click('Queue retry')
    expect(await api.queue(id)).toMatchObject({ paused: true, messages: [{ state: 'queued' }] })
    await click('Resume queue')
    expect((await api.queue(id)).messages[0]?.state).toBe('sending')
  })

  it('does not clear a new draft when an earlier send acknowledges late', async () => {
    const api = createMockApi()
    const realSend = api.sendMessage
    let release!: () => void
    vi.spyOn(api, 'sendMessage').mockImplementation(async (...args) => {
      const result = await realSend(...args)
      await new Promise<void>(resolve => {
        release = resolve
      })
      return result
    })
    await open(api)
    const textarea = () => wrapper!.find('textarea[aria-label="Message"]')
    await textarea().setValue('First')
    await wrapper!.find('button[aria-label="Send"]').trigger('click')
    await flushPromises()
    useDrafts().set(FIXTURE_SESSION_IDS.running, { text: 'Keep this draft', attachments: [] })
    release()
    await flushPromises()
    expect((textarea().element as HTMLTextAreaElement).value).toBe('Keep this draft')
  })

  it('reuses the request id after a lost acknowledgement and sends only once', async () => {
    const api = createMockApi()
    const realSend = api.sendMessage
    const send = vi.spyOn(api, 'sendMessage').mockImplementationOnce(async (...args) => {
      await realSend(...args)
      throw new TypeError('Connection lost')
    })
    vi.spyOn(api, 'queue').mockRejectedValueOnce(new TypeError('Still disconnected'))
    await open(api)
    await wrapper!.find('textarea[aria-label="Message"]').setValue('Do once')
    await wrapper!.find('button[aria-label="Send"]').trigger('click')
    await flushPromises()
    await click('Retry original message')
    expect(send.mock.calls[0]![1].clientId).toBe(send.mock.calls[1]![1].clientId)
    expect((await api.queue(FIXTURE_SESSION_IDS.running)).messages).toHaveLength(1)
  })

  it('sends the next queued message now and hides a message already handed off', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    await open(api)
    await wrapper!.find('textarea[aria-label="Message"]').setValue('Check the queue')
    await wrapper!.find('button[aria-label="Send"]').trigger('click')
    await flushPromises()
    const queue = wrapper!.find('[aria-label="Message queue"]')
    expect(queue.text()).toContain('Check the queue')
    expect(queue.text()).not.toContain('In progress')
    const sendNow = queue.findAll('button').find(b => b.text().trim() === 'Send now')
    expect(sendNow).toBeDefined()
    await sendNow!.trigger('click')
    await flushPromises()
    expect(wrapper!.text()).toContain('Check the queue')
    expect(wrapper!.find('[aria-label="Message queue"]').exists()).toBe(false)
    expect((await api.queue(id)).messages[0]?.state).toBe('sending')
  })

  it('sends the draft immediately with the button and with /send', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    const now = vi.spyOn(api, 'sendNow')
    await open(api)
    const textarea = wrapper!.find('textarea[aria-label="Message"]')
    await textarea.setValue('Right away')
    const button = wrapper!.findAll('button').find(b => b.text().trim() === 'Send now')
    expect(button).toBeDefined()
    await button!.trigger('click')
    await flushPromises()
    expect(now).toHaveBeenCalledWith(id, expect.objectContaining({ text: 'Right away' }))
    expect((textarea.element as HTMLTextAreaElement).value).toBe('')
    expect(wrapper!.text()).toContain('Right away')

    await textarea.setValue('/send ahead of this turn')
    await textarea.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(now).toHaveBeenLastCalledWith(
      id,
      expect.objectContaining({ text: 'ahead of this turn' }),
    )
    expect(useCommands().value.map(c => c.id)).toContain('session-send-now')
  })

  it('holds paused older messages when another message is submitted', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    await api.sendMessage(id, { text: 'Older' })
    await api.interruptSession(id)
    await api.sendMessage(id, { text: 'Newer' })
    expect(await api.queue(id)).toMatchObject({
      paused: true,
      messages: [
        { message: { text: 'Older' }, state: 'queued' },
        { message: { text: 'Newer' }, state: 'queued' },
      ],
    })
  })

  it('keeps newer queue SSE over a stale reconnect snapshot', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    let reconnect!: () => void
    const subscribe = api.subscribe
    vi.spyOn(api, 'subscribe').mockImplementation((listener, onReconnect) => {
      if (onReconnect && !reconnect) reconnect = onReconnect
      return subscribe(listener, onReconnect)
    })
    await open(api)
    const stale = await api.getSession(id)
    let release!: (detail: typeof stale) => void
    vi.spyOn(api, 'getSession').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        }),
    )
    reconnect()
    await api.sendMessage(id, { text: 'Newer snapshot' })
    release(stale)
    await flushPromises()
    expect(wrapper!.find('.message-queue').text()).toContain('Newer snapshot')
  })

  it('preserves action queue updates over an older in-flight detail without SSE', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    let reconnect!: () => void
    const subscribe = api.subscribe
    vi.spyOn(api, 'subscribe').mockImplementation((listener, onReconnect) => {
      if (onReconnect && !reconnect) reconnect = onReconnect
      return subscribe(event => {
        if (event.type !== 'session.queue') listener(event)
      }, onReconnect)
    })
    await api.sendMessage(id, { text: 'Before edit' })
    await open(api)
    const stale = await api.getSession(id)
    let release!: (detail: typeof stale) => void
    vi.spyOn(api, 'getSession').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        }),
    )
    reconnect()
    await click('Edit')
    await wrapper!.find('.message-queue textarea').setValue('After edit')
    await click('Save message')
    release(stale)
    await flushPromises()
    expect(wrapper!.find('.message-queue').text()).toContain('After edit')
    expect(wrapper!.find('.message-queue').text()).not.toContain('Before edit')
  })

  it('keeps uncertain original separate from newer typing after failed acknowledgement', async () => {
    const api = createMockApi()
    let reject!: (error: Error) => void
    vi.spyOn(api, 'sendMessage').mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail
        }),
    )
    await open(api)
    const textarea = () => wrapper!.find('textarea[aria-label="Message"]')
    await textarea().setValue('Original action')
    await wrapper!.find('button[aria-label="Send"]').trigger('click')
    await flushPromises()
    useDrafts().set(FIXTURE_SESSION_IDS.running, { text: 'Newer draft', attachments: [] })
    reject(new Error('Disconnected'))
    await flushPromises()
    expect((textarea().element as HTMLTextAreaElement).value).toBe('Newer draft')
    expect(wrapper!.text()).toContain('Message not acknowledged')
    await click('Retry original message')
    expect((await api.queue(FIXTURE_SESSION_IDS.running)).messages[0]?.message.text).toBe(
      'Original action',
    )
    expect((textarea().element as HTMLTextAreaElement).value).toBe('Newer draft')
  })

  it('keeps failed in-flight work uncertain and pauses pending work', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.idle
    await api.sendMessage(id, { text: 'Active' })
    await api.sendMessage(id, { text: 'Next' })
    api.harnessEvent(id, { type: 'turn.end', ok: false, error: 'Usage exhausted', durationMs: 0 })
    api.harnessEvent(id, { type: 'state', state: 'idle' })
    expect(await api.queue(id)).toMatchObject({
      paused: true,
      messages: [{ state: 'uncertain' }, { state: 'queued' }],
    })
  })

  it('retains a failed request key across navigation until the exact request is acknowledged', () => {
    const first = messageAttempt('retry-test', { text: 'A' })
    expect(messageAttempt('retry-test', { text: 'A' }).clientId).toBe(first.clientId)
    const changed = messageAttempt('retry-test', { text: 'B' })
    expect(changed.clientId).not.toBe(first.clientId)
    completeMessageAttempt('retry-test', first.clientId!)
    expect(messageAttempt('retry-test', { text: 'B' }).clientId).toBe(changed.clientId)
    completeMessageAttempt('retry-test', changed.clientId!)
    expect(messageAttempt('retry-test', { text: 'B' }).clientId).not.toBe(changed.clientId)
  })

  it('restores an unresolved original payload and attachments after a module reload', async () => {
    const message = messageAttempt('reload-test', {
      text: 'Original with file',
      attachments: [{ name: 'note.txt', mediaType: 'text/plain', data: 'saved content' }],
    })
    vi.resetModules()
    const recovered = await import('./sendAttempt')
    expect(recovered.unresolvedMessages.value).toContainEqual({ sessionId: 'reload-test', message })
    expect(
      recovered.messageAttempt('reload-test', {
        text: message.text,
        attachments: message.attachments,
      }).clientId,
    ).toBe(message.clientId)
    recovered.completeMessageAttempt('reload-test', message.clientId!)
  })
})
