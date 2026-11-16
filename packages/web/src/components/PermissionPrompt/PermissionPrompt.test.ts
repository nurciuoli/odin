import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuPermissionPrompt, type PermissionPromptRequest } from './index'

const req = (over: Partial<PermissionPromptRequest> = {}): PermissionPromptRequest => ({
  id: 'p1',
  kind: 'tool',
  tool: 'Bash',
  title: 'Claude wants to run: npm test',
  input: { command: 'npm test', cwd: '/repo' },
  canAlwaysAllow: true,
  defaultToDeny: false,
  ...over,
})

const mountIt = (request: PermissionPromptRequest, props: Record<string, unknown> = {}) =>
  mount(IuPermissionPrompt, { props: { request, ...props }, attachTo: document.body })

const answers = (w: ReturnType<typeof mountIt>) => w.emitted('answer')?.map(a => a[0])
const button = (w: ReturnType<typeof mountIt>, text: string) =>
  w.findAll('button').find(b => b.text().includes(text))!

describe('IuPermissionPrompt', () => {
  it('answers free-text questions and keeps duplicate question text distinct by native id', async () => {
    const w = mountIt(
      req({
        kind: 'question',
        questions: [
          { id: 'first', question: 'Details?', header: '', options: [] },
          { id: 'second', question: 'Details?', header: '', options: [] },
        ],
      }),
    )
    expect(button(w, 'Submit answers').attributes('disabled')).toBeDefined()
    await w.findAll('textarea')[0]!.setValue('One')
    await w.findAll('textarea')[1]!.setValue('Two')
    await button(w, 'Submit answers').trigger('click')
    expect(answers(w)).toEqual([
      { behavior: 'allow', scope: 'once', answers: { first: 'One', second: 'Two' } },
    ])
    w.unmount()
  })
  it('shows the title as text, the command in a code block and other input as properties', () => {
    const w = mountIt(req())
    expect(w.attributes('role')).toBe('group')
    expect(w.attributes('aria-describedby')).toBeTruthy()
    expect(w.text()).toContain('Claude wants to run: npm test')
    expect(w.find('.iu-code').text()).toContain('npm test')
    expect(w.find('.iu-props').text()).toContain('/repo')
    w.unmount()
  })
  it('renders an edit diff', () => {
    const w = mountIt(
      req({
        tool: 'Edit',
        input: { file_path: '/a.ts' },
        diff: [{ lines: [{ type: 'add', newNum: 1, content: 'x' }] }],
      }),
    )
    expect(w.find('.iu-diff').exists()).toBe(true)
    w.unmount()
  })
  it('allows once', async () => {
    const w = mountIt(req())
    await button(w, 'Allow once').trigger('click')
    expect(answers(w)).toEqual([{ behavior: 'allow', scope: 'once' }])
    w.unmount()
  })
  it('allows once with ctrl+enter unless defaultToDeny', async () => {
    const w = mountIt(req())
    await w.trigger('keydown', { key: 'Enter', ctrlKey: true, metaKey: true })
    expect(answers(w)).toEqual([{ behavior: 'allow', scope: 'once' }])
    w.unmount()
    const careful = mountIt(req({ defaultToDeny: true }))
    await careful.trigger('keydown', { key: 'Enter', ctrlKey: true, metaKey: true })
    expect(answers(careful)).toBeUndefined()
    expect(careful.find('kbd').exists()).toBe(false)
    careful.unmount()
  })
  it('focuses Deny first when defaultToDeny', () => {
    const w = mountIt(req({ defaultToDeny: true }))
    expect(document.activeElement).toBe(button(w, 'Deny').element)
    w.unmount()
  })
  it('offers the scope menu and emits the chosen scope', async () => {
    const w = mountIt(req())
    await button(w, 'Always allow').trigger('click')
    const items = w.findAll('[role="menuitem"]')
    expect(items.map(i => i.text())).toHaveLength(4)
    await items[1]!.trigger('click')
    expect(answers(w)).toEqual([{ behavior: 'allow', scope: 'project' }])
    w.unmount()
  })
  it('limits scopes and hides Always allow when canAlwaysAllow is false', () => {
    const w = mountIt(req({ canAlwaysAllow: false }))
    expect(w.findAll('button').some(b => b.text().includes('Always allow'))).toBe(false)
    w.unmount()
  })
  it('denies, with an optional message', async () => {
    const w = mountIt(req())
    await button(w, 'Deny').trigger('click')
    await button(w, 'Add a message').trigger('click')
    await w.find('textarea').setValue('use pnpm')
    await button(w, 'Deny').trigger('click')
    expect(answers(w)).toEqual([{ behavior: 'deny' }, { behavior: 'deny', message: 'use pnpm' }])
    w.unmount()
  })
  it('disables controls while busy', async () => {
    const w = mountIt(req(), { busy: true })
    await button(w, 'Allow once').trigger('click')
    await w.trigger('keydown', { key: 'Enter', ctrlKey: true, metaKey: true })
    expect(answers(w)).toBeUndefined()
    w.unmount()
  })
  it('approves or keeps planning on a plan', async () => {
    const w = mountIt(
      req({ kind: 'plan', tool: 'ExitPlanMode', input: undefined, plan: '# Plan\n\n- step' }),
    )
    expect(w.find('.iu-md').exists()).toBe(true)
    await button(w, 'Approve plan').trigger('click')
    await button(w, 'Keep planning').trigger('click')
    expect(answers(w)).toEqual([{ behavior: 'allow', scope: 'once' }, { behavior: 'deny' }])
    w.unmount()
  })
  it("doesn't repeat a plan in the input list", () => {
    const plan = '1. Read\n2. Change'
    const w = mountIt(
      req({ kind: 'plan', tool: 'ExitPlanMode', input: { plan, extra: 'x' }, plan }),
    )
    expect(w.text()).toContain('extra')
    expect(w.findAll('.iu-md')).toHaveLength(1)
    expect(w.text().split('Change').length - 1).toBe(1)
    w.unmount()
  })
  it('collects question answers keyed by question text', async () => {
    const w = mountIt(
      req({
        kind: 'question',
        tool: 'AskUserQuestion',
        input: undefined,
        questions: [
          { question: 'Which db?', header: 'DB', options: [{ label: 'sqlite' }, { label: 'pg' }] },
          {
            question: 'Which extras?',
            header: 'Extras',
            multiSelect: true,
            options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }],
          },
        ],
      }),
    )
    const submit = button(w, 'Submit answers')
    expect(submit.attributes('disabled')).toBeDefined()
    const radios = w.findAll('input[type="radio"]')
    await radios[1]!.setValue(true)
    const boxes = w.findAll('input[type="checkbox"]')
    await boxes[0]!.setValue(true)
    await boxes[2]!.setValue(true)
    await submit.trigger('click')
    expect(answers(w)).toEqual([
      {
        behavior: 'allow',
        scope: 'once',
        answers: { 'Which db?': 'pg', 'Which extras?': 'a, c' },
      },
    ])
    expect(w.findAll('button').some(b => b.text().includes('Always allow'))).toBe(false)
    w.unmount()
  })

  it('offers Cancel only when cancellable, named for what it does, and emits cancel', async () => {
    expect(mountIt(req()).find('.iu-permission-prompt__cancel').exists()).toBe(false)
    const w = mountIt(req({ kind: 'question', questions: [] }), {
      cancellable: true,
      cancelLabel: 'Cancel and interrupt the agent',
    })
    const cancel = w.find('button[aria-label="Cancel and interrupt the agent"]')
    expect(cancel.element.tagName).toBe('BUTTON')
    expect(cancel.text()).toBe('Cancel')
    await cancel.trigger('click')
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('answer')).toBeUndefined()
    await w.setProps({ busy: true })
    expect(cancel.attributes('disabled')).toBeDefined()
    w.unmount()
  })
})
