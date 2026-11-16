import { expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import NotebookWidget from './NotebookWidget.vue'
it('requires explicit enabling before rendering a callback-capable widget iframe', async () => {
  const api = createMockApi()
  const request = vi.spyOn(api, 'notebookWidgetState')
  const wrapper = mount(NotebookWidget, {
    props: { kernelId: 'k', modelId: 'm' },
    global: { provide: { [API_KEY as symbol]: api } },
  })
  expect(wrapper.find('iframe').exists()).toBe(false)
  expect(request).not.toHaveBeenCalled()
  await wrapper.find('button').trigger('click')
  await flushPromises()
  expect(wrapper.find('iframe').attributes('sandbox')).toBe('allow-scripts allow-forms')
  expect(wrapper.find('iframe').attributes('src')).toBe('/a/notebook-widgets/k/m')
  expect(request).not.toHaveBeenCalled()
  await wrapper.find('button').trigger('click')
  expect(wrapper.find('iframe').exists()).toBe(false)
  wrapper.unmount()
})
