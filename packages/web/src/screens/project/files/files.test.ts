import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import { createMockApi } from '@/api/mock'
import { MOCK_FILE_MAP } from '@/api/mock.filemap'
import {
  buildTree,
  chain,
  folderPaths,
  indexTree,
  lean,
  moveTargets,
  nameProblem,
  nodeBytes,
  tintPercent,
  under,
} from './files'
import { treemap } from './treemap'
import FilesScreen from './FilesScreen.vue'

describe('treemap', () => {
  it('fills the box without overlap', () => {
    const rects = treemap(
      [
        { id: 'a', value: 6 },
        { id: 'b', value: 3 },
        { id: 'c', value: 1 },
      ],
      100,
      50,
    )
    expect(rects).toHaveLength(3)
    const area = rects.reduce((t, r) => t + r.w * r.h, 0)
    expect(Math.round(area)).toBe(5000)
    expect(rects.find(r => r.id === 'a')!.w * rects.find(r => r.id === 'a')!.h).toBeCloseTo(3000)
  })

  it('drops empty items and empty boxes', () => {
    expect(treemap([{ id: 'a', value: 0 }], 100, 50)).toEqual([])
    expect(treemap([{ id: 'a', value: 1 }], 0, 50)).toEqual([])
  })
})

describe('file tree', () => {
  const tree = buildTree('demo', MOCK_FILE_MAP.files)
  const idx = indexTree(tree)

  it('sums folder sizes from their files', () => {
    const apps = idx.get('apps')!.node
    expect(nodeBytes(apps)).toBeGreaterThan(0)
    expect(nodeBytes(tree)).toBe((tree.children ?? []).reduce((t, c) => t + nodeBytes(c), 0))
  })

  it('walks from the root to a file', () => {
    expect(chain(idx, 'apps/api/src/lib/db.ts').map(n => n.name)).toEqual([
      'demo',
      'apps',
      'api',
      'src',
      'lib',
      'db.ts',
    ])
    expect(under(idx, 'apps/api', 'apps/api/src/lib/db.ts')).toBe(true)
    expect(under(idx, 'apps/web', 'apps/api/src/lib/db.ts')).toBe(false)
  })

  it('leans a diff by what it did', () => {
    expect(lean({ added: 10, removed: 0, lines: 20 }).kind).toBe('add')
    expect(lean({ added: 0, removed: 10, lines: 20 }).kind).toBe('remove')
    expect(lean({ added: 5, removed: 5, lines: 20 }).kind).toBe('mix')
    expect(tintPercent(undefined)).toBe(0)
    expect(tintPercent({ added: 0, removed: 0, lines: 10 })).toBe(0)
  })
})

describe('FilesScreen', () => {
  it('maps the project, shows diff counts and opens a file', async () => {
    // happy-dom has no layout: give every element a size so the treemap has room
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200)
    const h = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
    const { wrapper } = await mountProjectScreen(FilesScreen, '/p/odin/files')
    await flushPromises()
    await flushPromises()
    expect(wrapper.find('.files__plate').exists()).toBe(false)
    const radios = wrapper.findAll('[role="radio"]')
    expect(radios.map(r => r.text())).toEqual(['Heatmap', 'List', 'State', 'Diff'])
    await radios[3]!.trigger('click')
    expect(wrapper.text()).toMatch(/\d+ files/)
    const schema = wrapper.findAll('.files__cell--leaf').find(c => c.text().includes('schema.sql'))
    expect(schema).toBeTruthy()
    await schema!.trigger('click')
    expect(wrapper.get('.files__plate').text()).toContain('db/schema.sql')
    await flushPromises()
    expect(wrapper.get('.files__plate').text()).toContain('sample contents')
    // arrows step through the files on the map; Escape closes the panel
    const before = wrapper.get('.files__title').text()
    await wrapper.get('[aria-label="Next file"]').trigger('click')
    expect(wrapper.get('.files__title').text()).not.toBe(before)
    await wrapper.get('[aria-label="Previous file"]').trigger('click')
    expect(wrapper.get('.files__title').text()).toBe(before)
    await wrapper.get('.files__cell--selected').trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.get('.files__title').text()).not.toBe(before)
    await wrapper.get('[aria-label="Close preview"]').trigger('click')
    expect(wrapper.find('.files__plate').exists()).toBe(false)
    // markdown renders; its source is one toggle away
    const md = wrapper.findAll('.files__cell--leaf').find(c => c.text().includes('README.md'))
    await md!.trigger('click')
    await flushPromises()
    expect(wrapper.get('.files__body').find('h1').exists()).toBe(true)
    await wrapper.findAll('.files__plate [role="radio"]')[1]!.trigger('click')
    expect(wrapper.get('.files__body').find('h1').exists()).toBe(false)
    await radios[1]!.trigger('click')
    expect(wrapper.find('.files__map').exists()).toBe(false)
    const row = wrapper.findAll('.files__row').find(r => r.text().includes('db/'))
    expect(row).toBeTruthy()
    await row!.trigger('click')
    expect(wrapper.findAll('.files__row').some(r => r.text().includes('schema.sql'))).toBe(true)
    wrapper.unmount()
    w.mockRestore()
    h.mockRestore()
  })
})

describe('file management helpers', () => {
  const tree = buildTree('odin', [
    { path: 'a.md', size: 1 },
    { path: 'docs/b.md', size: 1 },
    { path: 'docs/deep/c.md', size: 1 },
    { path: 'src/d.ts', size: 1 },
  ])
  it('lists every folder, root first', () => {
    expect(folderPaths(tree)).toEqual(['', 'docs', 'docs/deep', 'src'])
  })
  it('leaves out a moved folder, its children and where the files already are', () => {
    const all = folderPaths(tree)
    expect(moveTargets(all, ['docs'])).toEqual(['src'])
    expect(moveTargets(all, ['docs/b.md'])).toEqual(['', 'docs/deep', 'src'])
    expect(moveTargets(all, ['a.md'])).toEqual(['docs', 'docs/deep', 'src'])
  })
  it('explains a bad name', () => {
    expect(nameProblem('')).toMatch(/Enter/)
    expect(nameProblem('a/b')).toMatch(/can.t contain/)
    expect(nameProblem('x.')).toMatch(/end with/)
    expect(nameProblem('notes v2.md')).toBe('')
  })
})

describe('file management in the mock API', () => {
  it('renames, moves, duplicates, trashes and restores', async () => {
    const api = createMockApi()
    const paths = async () => (await api.getProjectFileMap('odin')).files.map(f => f.path)
    const first = (await paths()).find(p => p.includes('/'))!
    const dir = first.slice(0, first.lastIndexOf('/'))
    const leaf = first.split('/').pop()!
    expect((await api.renameProjectFile('odin', first, 'renamed.txt')).path).toBe(
      `${dir}/renamed.txt`,
    )
    const moved = await api.moveProjectFiles('odin', [`${dir}/renamed.txt`], '')
    expect(moved.moved).toEqual([{ from: `${dir}/renamed.txt`, to: 'renamed.txt' }])
    const copy = await api.duplicateProjectFile('odin', 'renamed.txt')
    expect(copy.path).toBe('renamed copy.txt')
    await expect(
      api.renameProjectFile('odin', 'renamed copy.txt', 'renamed.txt'),
    ).rejects.toMatchObject({ status: 409 })
    const [entry] = await api.trashProjectFiles('odin', ['renamed.txt'])
    expect(await paths()).not.toContain('renamed.txt')
    expect((await api.listProjectTrash('odin')).map(t => t.path)).toEqual(['renamed.txt'])
    await api.restoreProjectTrash('odin', entry!.id)
    expect(await paths()).toContain('renamed.txt')
    await api.trashProjectFiles('odin', ['renamed.txt'])
    await api.purgeProjectTrash('odin')
    expect(await api.listProjectTrash('odin')).toEqual([])
    expect(leaf).toBeTruthy()
  })
})

describe('FilesScreen file management', () => {
  it('trashes a checked file from the list and restores it from the trash dialog', async () => {
    HTMLDialogElement.prototype.showModal ??= function () {
      this.setAttribute('open', '')
    }
    HTMLDialogElement.prototype.close ??= function () {
      this.removeAttribute('open')
    }
    const api = createMockApi()
    const { wrapper } = await mountProjectScreen(FilesScreen, '/p/odin/files', api)
    await flushPromises()
    await wrapper.findAll('[role="radio"]')[1]!.trigger('click')
    expect(wrapper.find('[role="toolbar"]').exists()).toBe(false)
    const item = wrapper.findAll('.files__item').find(i => !i.text().includes('/'))!
    const name = item.get('.files__row-name').text()
    await item.get('input[type=checkbox]').setValue(true)
    expect(wrapper.get('[role="toolbar"]').text()).toContain('1 selected')
    await wrapper
      .get('[role="toolbar"]')
      .findAll('button')
      .find(b => b.text() === 'Trash')!
      .trigger('click')
    await flushPromises()
    expect((await api.listProjectTrash('odin')).length).toBe(1)
    expect(wrapper.findAll('.files__row-name').some(r => r.text() === name)).toBe(false)
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Trash')!
      .trigger('click')
    await flushPromises()
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Restore')!
      .trigger('click')
    await flushPromises()
    expect((await api.listProjectTrash('odin')).length).toBe(0)
    expect(wrapper.findAll('.files__row-name').some(r => r.text() === name)).toBe(true)
    wrapper.unmount()
  })
})
