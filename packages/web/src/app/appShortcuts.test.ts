import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { mountScreen } from '@/screens/shared/testSupport'
import { useAppShortcuts } from './appShortcuts'
import { useSessions } from './sessions'

const dialogs = { palette: ref(false), quickLaunch: ref(false), help: ref(false) }
const Shell = defineComponent({
  setup() {
    useAppShortcuts(dialogs, useSessions())
    return () => h('div')
  },
})
const press = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

afterEach(() => {
  dialogs.palette.value = dialogs.quickLaunch.value = dialogs.help.value = false
  document.body.innerHTML = ''
})

it('opens the palette, quick launch and cheat sheet, and moves between sessions', async () => {
  const { wrapper, router, sessions, projects } = await mountScreen(Shell, '/')
  await flushPromises()
  press({ key: 'k', ctrlKey: true })
  expect(dialogs.palette.value).toBe(true)
  press({ key: 'k', ctrlKey: true })
  expect(dialogs.palette.value).toBe(false)
  press({ key: 'O', code: 'KeyO', ctrlKey: true, shiftKey: true })
  expect(dialogs.quickLaunch.value).toBe(true)
  press({ key: '?', shiftKey: true })
  expect(dialogs.help.value).toBe(true)

  press({ key: 'j', ctrlKey: true })
  await vi.waitFor(
    () => expect(router.currentRoute.value.params.id).toBe(FIXTURE_SESSION_IDS.waiting),
    {
      timeout: 8000,
    },
  )
  // the sidebar order: waiting, then running
  press({ key: 'ArrowDown', altKey: true })
  await vi.waitFor(() =>
    expect(router.currentRoute.value.params.id).toBe(FIXTURE_SESSION_IDS.running),
  )
  press({ key: '1', code: 'Digit1', ctrlKey: true })
  await vi.waitFor(() =>
    expect(router.currentRoute.value.params.id).toBe(FIXTURE_SESSION_IDS.waiting),
  )
  wrapper.unmount()
  sessions.stop()
  projects.stop()
})
