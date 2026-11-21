import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ComposerProjects from './ComposerProjects.vue'

const options = [
  { id: 'odin', label: 'Odin' },
  { id: 'quant', label: 'open-quant' },
]

function mountProjects(start: string[]) {
  const w = mount(ComposerProjects, {
    attachTo: document.body,
    props: {
      modelValue: start[0] ?? '',
      projects: start,
      options,
      'onUpdate:modelValue': (v: string) => w.setProps({ modelValue: v }),
      'onUpdate:projects': (v: string[]) => w.setProps({ projects: v }),
    },
  })
  return w
}
async function choose(w: ReturnType<typeof mountProjects>, label: string) {
  await w.find('button[aria-haspopup="menu"]').trigger('click')
  const item = [...document.body.querySelectorAll<HTMLElement>('[role^="menuitem"]')].find(el =>
    el.textContent?.includes(label),
  )
  item!.click()
  await w.vm.$nextTick()
}

describe('ComposerProjects', () => {
  it('moves the working repository off a project that was unchecked', async () => {
    const w = mountProjects(['odin', 'quant'])
    await choose(w, 'Odin')
    expect(w.props('projects')).toEqual(['quant'])
    expect(w.props('modelValue')).toBe('quant')
    w.unmount()
  })

  it('makes a newly checked repository the working one', async () => {
    const w = mountProjects(['odin'])
    await choose(w, 'open-quant')
    expect(w.props('projects')).toEqual(['odin', 'quant'])
    expect(w.props('modelValue')).toBe('quant')
    w.unmount()
  })
})
