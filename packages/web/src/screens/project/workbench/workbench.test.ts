import { afterEach, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import ProjectLayout from '../ProjectLayout.vue'
import ProjectFilesPanel from './ProjectFilesPanel.vue'

afterEach(() => localStorage.clear())

it('shows the Overview as the page with the sections in a panel on the right', async () => {
  const { wrapper, router } = await mountProjectScreen(ProjectLayout, '/p/odin/sessions')
  wrapper.setProps({ name: 'odin' })
  await flushPromises()
  const tabs = wrapper.findAll('[role="tab"]').map(t => t.text().replace(/\s*\d+$/, ''))
  expect(tabs).toEqual(['Files', 'Sessions', 'Outputs', 'Resources', 'Settings'])
  expect(wrapper.find('.overview').exists()).toBe(true)
  expect(wrapper.find('[role="tab"][aria-selected="true"]').text()).toContain('Sessions')

  await wrapper.find('[aria-label="Full screen"]').trigger('click')
  expect(wrapper.find('.project-workbench-shell[data-full]').exists()).toBe(true)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await flushPromises()
  expect(wrapper.find('.project-workbench-shell[data-full]').exists()).toBe(false)

  await wrapper.find('.project-workbench [aria-label="Hide panel"]').trigger('click')
  await flushPromises()
  expect(wrapper.find('.project-workbench').exists()).toBe(false)
  expect(router.currentRoute.value.name).toBe('project-overview')
  wrapper.unmount()
})

it('browses folders and previews a file in the Files tab', async () => {
  const { wrapper } = await mountProjectScreen(ProjectFilesPanel, '/p/odin/files', createMockApi())
  await flushPromises()
  const folder = wrapper.findAll('.pfiles__row').find(r => r.text().startsWith('packages'))!
  await folder.trigger('click')
  expect(wrapper.find('.pfiles__crumbs').text()).toContain('packages')
  await wrapper.find('.pfiles__crumb').trigger('click')
  const file = wrapper.findAll('.pfiles__row').find(r => r.text().startsWith('package.json'))!
  await file.trigger('click')
  await flushPromises()
  expect(wrapper.find('.pfiles__title').text()).toBe('package.json')
  expect(wrapper.find('.pfiles__body').text()).toContain('sample contents')
  wrapper.unmount()
})
