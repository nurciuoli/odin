import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ComposerWhere from './ComposerWhere.vue'
import {
  branchProblem,
  emptySessionForm,
  slugFromPrompt,
  validateSessionForm,
} from './newSessionForm'

function mountWhere(props: Record<string, unknown> = {}) {
  const w = mount(ComposerWhere, {
    attachTo: document.body,
    props: {
      worktree: true,
      branch: '',
      open: false,
      'onUpdate:worktree': (v: boolean) => w.setProps({ worktree: v }),
      'onUpdate:branch': (v: string) => w.setProps({ branch: v }),
      'onUpdate:open': (v: boolean) => w.setProps({ open: v }),
      ...props,
    },
  })
  return w
}

describe('slugFromPrompt', () => {
  it('takes the first meaningful words', () => {
    expect(slugFromPrompt('Please fix the flaky history search test in CI')).toBe(
      'fix-flaky-history-search',
    )
  })
  it('is git-valid and capped', () => {
    const slug = slugFromPrompt('Refactor!! the Uber-long_identifier/path.name: ' + 'x'.repeat(80))
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(branchProblem(slug)).toBeUndefined()
    expect(slugFromPrompt('x'.repeat(80))).toHaveLength(40)
  })
  it('is empty when there is nothing to use', () => {
    expect(slugFromPrompt('  ?!  ')).toBe('')
    expect(slugFromPrompt('')).toBe('')
  })
})

describe('branchProblem', () => {
  it('accepts empty and valid names, rejects invalid ones', () => {
    expect(branchProblem('')).toBeUndefined()
    expect(branchProblem('feat/new-thing')).toBeUndefined()
    for (const bad of ['a..b', 'a//b', 'a/', 'a.', 'a.lock', '.hidden', 'a/.b', 'a b'])
      expect(branchProblem(bad), bad).toBe('Use a valid Git branch name.')
  })
  it('only applies to the form when a worktree is wanted', () => {
    const form = { ...emptySessionForm('odin'), prompt: 'x', branch: 'a..b' }
    expect(validateSessionForm(form).branch).toBeUndefined()
    expect(validateSessionForm({ ...form, worktree: true }).branch).toBe(
      'Use a valid Git branch name.',
    )
  })
})

describe('ComposerWhere', () => {
  it('labels the chip with text and exposes dialog semantics', async () => {
    const w = mountWhere({ worktree: false })
    const chip = w.find('button')
    expect(chip.text()).toContain('This checkout')
    expect(chip.attributes('aria-haspopup')).toBe('dialog')
    expect(chip.attributes('aria-expanded')).toBe('false')
    await chip.trigger('click')
    expect(w.find('button').attributes('aria-expanded')).toBe('true')
    expect(w.find('.composer-where__input').exists()).toBe(false)
    w.unmount()
  })
  it('previews the slug and offers it as a suggestion, with arrow keys and Enter', async () => {
    const w = mountWhere({ prompt: 'Add retry to uploads', open: true })
    const input = w.find('.composer-where__input')
    expect(input.attributes('placeholder')).toBe('add-retry-uploads')
    await input.trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('.composer-where__suggestion--active').text()).toBe('add-retry-uploads')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.props('branch')).toBe('add-retry-uploads')
    expect(w.props('open')).toBe(false)
    w.unmount()
  })
  it('adds recent prefixes, at most three suggestions', () => {
    const w = mountWhere({
      prompt: 'Add retry',
      open: true,
      recentPrefixes: ['feat/', 'fix/', 'chore/'],
    })
    expect(w.findAll('.composer-where__suggestion').map(b => b.text())).toEqual([
      'add-retry',
      'feat/add-retry',
      'fix/add-retry',
    ])
    w.unmount()
  })
  it('renders no suggestions without a prompt', () => {
    const w = mountWhere({ open: true })
    expect(w.find('.composer-where__suggestions').exists()).toBe(false)
    w.unmount()
  })
  it('shows an inline error, keeps Enter from closing, and Esc returns focus to the chip', async () => {
    const w = mountWhere({ branch: 'a..b', open: true })
    expect(w.find('[role="status"]').text()).toContain('valid Git branch')
    const input = w.find('.composer-where__input')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.props('open')).toBe(true)
    await input.trigger('keydown', { key: 'Escape' })
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    expect(w.props('open')).toBe(false)
    expect(document.activeElement).toBe(w.find('button').element)
    w.unmount()
  })
})
