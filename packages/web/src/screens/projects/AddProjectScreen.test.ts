import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { ApiRequestError } from '@/api'
import { mountScreen } from '@/screens/shared/testSupport'
import AddProjectScreen from './AddProjectScreen.vue'

const mountAdd = () => mountScreen(AddProjectScreen, '/projects/new')

describe('AddProjectScreen', () => {
  it('browses, filters and selects a folder without typing a path', async () => {
    const { api, wrapper } = await mountAdd()
    const click = async (label: string) => {
      await wrapper
        .findAll('button')
        .find(b => b.text() === label)!
        .trigger('click')
      await flushPromises()
    }
    await click('Browse folders')
    expect(wrapper.text()).toContain('/work')
    await wrapper.findAll('input[type="text"]')[0]!.setValue('atl')
    expect(wrapper.find('#project-folders').text()).not.toContain('rick /')
    await click('atlas /')
    expect(wrapper.text()).toContain('No subfolders')
    await click('Up one folder')
    await click('atlas /')
    await click('Use this folder')
    expect(wrapper.find('#project-folders').exists()).toBe(false)
    const [path, name] = wrapper.findAll('input[type="text"]')
    expect((path!.element as HTMLInputElement).value).toBe('/work/atlas')
    expect((name!.element as HTMLInputElement).value).toBe('atlas')
    expect((await api.listProjects()).map(p => p.name)).not.toContain('atlas')
  })

  it('keeps a custom name and supports recovery from an unreadable folder', async () => {
    const { api, wrapper } = await mountAdd()
    const [path, name] = wrapper.findAll('input[type="text"]')
    await path!.setValue('/missing')
    await name!.setValue('custom')
    const real = api.browseProjectFolders.bind(api)
    api.browseProjectFolders = p =>
      p === '/missing' ? Promise.reject(new Error('Folder unavailable')) : real(p)
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Browse folders')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Folder unavailable')
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Projects / home')!
      .trigger('click')
    await flushPromises()
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Use this folder')!
      .trigger('click')
    await flushPromises()
    expect((name!.element as HTMLInputElement).value).toBe('custom')
    expect((path!.element as HTMLInputElement).value).toBe('/work')
  })
  it('shows what is missing on submit and creates nothing', async () => {
    const { api, wrapper } = await mountAdd()
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('Enter the folder path.')
    expect((await api.listProjects()).map(p => p.name)).toEqual(['odin', 'rick', 'harbor'])
  })

  it('fills the name from the path until the user edits it', async () => {
    const { wrapper } = await mountAdd()
    const [path, name] = wrapper.findAll('input[type="text"]')
    await path!.setValue('/work/Atlas Project')
    expect((name!.element as HTMLInputElement).value).toBe('atlas-project')
    await name!.setValue('custom')
    await path!.setValue('/work/other')
    expect((name!.element as HTMLInputElement).value).toBe('custom')
  })

  it('flags a relative path and an invalid name', async () => {
    const { wrapper } = await mountAdd()
    const [path, name] = wrapper.findAll('input[type="text"]')
    await path!.setValue('work/atlas')
    await name!.setValue('Bad Name')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('Use an absolute path')
    expect(wrapper.text()).toContain('Lowercase letters, digits and dashes')
  })

  it('adds the project and goes to its overview', async () => {
    const { api, router, wrapper } = await mountAdd()
    await wrapper.findAll('input[type="text"]')[0]!.setValue('/work/atlas')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect((await api.listProjects()).map(p => p.name)).toContain('atlas')
    // the route's screens load lazily, so the navigation settles a moment later
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/p/atlas/overview'), {
      timeout: 5000,
    })
  })

  it('shows the server error when adding fails', async () => {
    const { wrapper } = await mountAdd()
    const [path, name] = wrapper.findAll('input[type="text"]')
    await path!.setValue('/work/rick')
    await name!.setValue('rick')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Project "rick" already exists')
    expect(wrapper.text()).not.toContain('Initialise git')
  })

  it('offers git init when the folder is not a repo, and sends it', async () => {
    const { api, wrapper } = await mountAdd()
    const real = api.createProject.bind(api)
    const calls: unknown[] = []
    api.createProject = req => {
      calls.push(req)
      return req.init
        ? real(req)
        : Promise.reject(new ApiRequestError(400, '/work/plain is not a git repository'))
    }
    await wrapper.findAll('input[type="text"]')[0]!.setValue('/work/plain')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Initialise git')
    await wrapper.find('input[type="checkbox"]').setValue(true)
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(calls[1]).toEqual({ path: '/work/plain', name: 'plain', init: true })
  })
})
