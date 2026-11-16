import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import { MOCK_FILE_MAP } from '@/api/mock.filemap'
import { buildTree, chain, indexTree, lean, nodeBytes, tintPercent, under } from './files'
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
    expect(radios.map(r => r.text())).toEqual(['State', 'Diff'])
    await radios[1]!.trigger('click')
    expect(wrapper.text()).toMatch(/\d+ files/)
    const schema = wrapper.findAll('.files__cell--leaf').find(c => c.text().includes('schema.sql'))
    expect(schema).toBeTruthy()
    await schema!.trigger('click')
    expect(wrapper.get('.files__plate').text()).toContain('db/schema.sql')
    await flushPromises()
    expect(wrapper.get('.files__plate').text()).toContain('sample contents')
    wrapper.unmount()
    w.mockRestore()
    h.mockRestore()
  })
})
