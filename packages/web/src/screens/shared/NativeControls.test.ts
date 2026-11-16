import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { mountScreen } from './testSupport'
import NativeControls from './NativeControls.vue'
import ComposerChoice from './ComposerChoice.vue'
import { buildStartRequest, emptySessionForm } from './newSessionForm'

describe('OpenCode native controls', () => {
  it('loads native metadata and emits native primary agents and model variants at launch', async () => {
    const api = createMockApi()
    const catalog = vi.spyOn(api, 'getNativeCatalog')
    const { wrapper } = await mountScreen(NativeControls, '/', api, {
      harness: 'opencode',
      project: 'odin',
      model: 'opencode/test',
      models: [
        {
          value: 'opencode/test',
          displayName: 'Test',
          description: '',
          resolved: null,
          variants: ['high'],
        },
      ],
    })
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(catalog).toHaveBeenCalledWith('opencode', 'odin')
    const choices = wrapper.findAllComponents(ComposerChoice)
    const agents = choices.find(c => c.props('label') === 'Native agent')!
    expect(agents.props('options')).toEqual(
      expect.arrayContaining([
        { id: 'build', label: 'build' },
        { id: 'plan', label: 'plan' },
      ]),
    )
    expect(agents.props('options')).not.toEqual(
      expect.arrayContaining([{ id: 'explore', label: 'explore' }]),
    )
    agents.vm.$emit('update:modelValue', 'plan')
    await flushPromises()
    expect(wrapper.emitted('change')?.at(-1)).toEqual([{ agent: 'plan' }])
    choices.find(c => c.props('label') === 'Model variant')!.vm.$emit('update:modelValue', 'high')
    await flushPromises()
    expect(wrapper.emitted('change')?.at(-1)).toEqual([{ agent: 'plan', variant: 'high' }])
  })

  it('saves native settings and reports native action failures without losing controls', async () => {
    const api = createMockApi()
    const update = vi.spyOn(api, 'updateSession')
    const action = vi
      .spyOn(api, 'sessionNativeAction')
      .mockRejectedValue(new Error('Session is busy'))
    const { wrapper } = await mountScreen(NativeControls, '/', api, {
      harness: 'opencode',
      project: 'odin',
      sessionId: 's-idle',
      model: null,
      models: [],
    })
    await wrapper.find('button').trigger('click')
    await flushPromises()
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Compact context')!
      .trigger('click')
    await flushPromises()
    expect(action).toHaveBeenCalledWith('s-idle', { type: 'compact' })
    expect(wrapper.find('[role="alert"]').text()).toContain('Session is busy')
    expect(update).not.toHaveBeenCalled()
    expect(
      wrapper
        .findAll('button')
        .find(b => b.text() === 'Compact context')!
        .attributes('disabled'),
    ).toBeUndefined()
  })

  it('asks the session to reload after a staged revert', async () => {
    const api = createMockApi()
    const { wrapper } = await mountScreen(NativeControls, '/', api, {
      harness: 'opencode',
      project: 'odin',
      sessionId: 's-idle',
      model: null,
      models: [],
    })
    await wrapper.find('button').trigger('click')
    await flushPromises()
    const label = wrapper.findAll('label').find(item => item.text() === 'Revert before message ID')
    expect(label).toBeTruthy()
    await wrapper.find(`#${label!.attributes('for')}`).setValue('message-1')
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Stage revert')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.emitted('history')).toHaveLength(1)
  })

  it('preserves native choices in the launch request', () => {
    const form = emptySessionForm('odin')
    form.harness = 'opencode'
    form.prompt = 'Review'
    form.runtimeOptions = {
      agent: 'plan',
      variant: 'high',
      permissionRules: [{ action: 'shell', resource: 'git *', effect: 'ask' }],
    }
    expect(buildStartRequest(form).runtimeOptions).toEqual(form.runtimeOptions)
  })
  it('preserves inherited rules until the user explicitly removes them', async () => {
    const api = createMockApi()
    const policy = [{ action: 'edit', resource: '*', effect: 'ask' as const }]
    const { wrapper } = await mountScreen(NativeControls, '/', api, {
      harness: 'opencode',
      project: 'odin',
      model: null,
      models: [],
      runtimeOptions: { permissionRules: policy },
    })
    await wrapper.find('button').trigger('click')
    await flushPromises()
    wrapper
      .findAllComponents(ComposerChoice)
      .find(c => c.props('label') === 'Native agent')!
      .vm.$emit('update:modelValue', 'plan')
    await flushPromises()
    expect(wrapper.emitted('change')?.at(-1)).toEqual([{ agent: 'plan', permissionRules: policy }])
    await wrapper.find('button[aria-label="Remove rule 1"]').trigger('click')
    expect(wrapper.emitted('change')?.at(-1)).toEqual([{ agent: 'plan', permissionRules: [] }])
  })
})
