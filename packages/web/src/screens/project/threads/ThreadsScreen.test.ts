import { expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import ThreadsScreen from './ThreadsScreen.vue'

it('lists coordinators with their threads, the one that needs you first', async () => {
  const { wrapper } = await mountProjectScreen(ThreadsScreen, '/p/odin/threads')
  await flushPromises()
  const rows = wrapper.findAll('.threads__row')
  expect(rows).toHaveLength(2)
  expect(rows[0]!.text()).toContain('Needs you')
  expect(rows[0]!.text()).toContain('Permission prompt component')
  expect(rows[1]!.text()).toContain('Running')
  expect(wrapper.text()).toContain('2 threads · 1 needs you · 1 running')
  // Status is a word in the badge, not only a colour; titles link to the session.
  expect(rows[0]!.find('a').attributes('href')).toMatch(/^\/s\//)
  wrapper.unmount()
})

it('starts a coordinator and opens it', async () => {
  const api = createMockApi()
  const { wrapper, router } = await mountProjectScreen(ThreadsScreen, '/p/odin/threads', api)
  await flushPromises()
  await wrapper.find('.threads__start textarea').setValue('Ship the onboarding flow')
  await wrapper.find('.threads__start').trigger('submit')
  // The session screen is a lazy route: wait for the navigation to land.
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('session'), { timeout: 5000 })
  const id = router.currentRoute.value.params.id as string
  const threads = await api.listProjectThreads('odin')
  expect(threads.coordinators[0]!.session.id).toBe(id)
  expect(threads.coordinators[0]!.session.tags).toContain('coordinator')
  wrapper.unmount()
})

it('edits the brief and memory files', async () => {
  const api = createMockApi()
  const { wrapper } = await mountProjectScreen(ThreadsScreen, '/p/odin/threads', api)
  await flushPromises()

  const brief = wrapper.find('#threads-brief').element.parentElement!
  const briefArea = wrapper.findAll('textarea').find(t => brief.contains(t.element))!
  expect((briefArea.element as HTMLTextAreaElement).value).toContain('Target main.')
  await briefArea.setValue('Target release branches.')
  await wrapper
    .findAll('form')
    .find(f => brief.contains(f.element))!
    .trigger('submit')
  await flushPromises()
  expect((await api.getProjectBrief('odin')).instructions).toBe('Target release branches.')

  // Open an existing file, change it, save.
  const file = wrapper.findAll('.threads__file').find(b => b.text().includes('pitfalls/sse.md'))!
  await file.trigger('click')
  await flushPromises()
  expect(file.attributes('aria-current')).toBe('true')
  const editor = wrapper.findAll('textarea').at(-1)!
  expect((editor.element as HTMLTextAreaElement).value).toContain('refetches REST state')
  await editor.setValue('Updated pitfall.\n')
  await wrapper.findAll('form').at(-1)!.trigger('submit')
  await flushPromises()
  expect((await api.readProjectMemory('odin', 'pitfalls/sse.md')).content).toBe(
    'Updated pitfall.\n',
  )

  // A new file with a bad name can't be saved; a good one can.
  await wrapper
    .findAll('button')
    .find(b => b.text() === 'New file')!
    .trigger('click')
  await flushPromises()
  const path = wrapper.find('.threads__memory input')
  await path.setValue('notes.txt')
  expect(wrapper.text()).toContain('end the name with .md')
  const save = wrapper.findAll('.threads__memory button').find(b => b.text() === 'Save')!
  expect(save.attributes('disabled')).toBeDefined()
  await path.setValue('decisions/db.md')
  await wrapper.findAll('textarea').at(-1)!.setValue('Use SQLite.\n')
  await wrapper.findAll('form').at(-1)!.trigger('submit')
  await flushPromises()
  expect((await api.getProjectBrief('odin')).memory.map(f => f.path)).toContain('decisions/db.md')
  wrapper.unmount()
})
