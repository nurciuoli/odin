import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuFilePath, fileName, relativePath, splitPath } from './index'

describe('relativePath', () => {
  const table: Record<string, [args: [string, (string | null)?], expected: string][]> = {
    'makes Windows paths relative to the root, with forward slashes': [
      [
        [
          'C:\\Users\\alex\\Documents\\code\\odin\\packages\\web\\src\\App.vue',
          'C:\\Users\\alex\\Documents\\code\\odin',
        ],
        'packages/web/src/App.vue',
      ],
    ],
    'compares Windows paths case-insensitively (drive letter and segments)': [
      [['c:\\Repo\\src\\a.ts', 'C:\\repo'], 'src/a.ts'],
      [['C:\\REPO\\src\\a.ts', 'c:\\repo\\'], 'src/a.ts'],
    ],
    'accepts mixed separators on Windows': [
      [['C:/repo/src\\a.ts', 'C:\\repo'], 'src/a.ts'],
      [['C:\\repo\\src\\a.ts', 'C:/repo/'], 'src/a.ts'],
    ],
    'handles UNC roots': [
      [['\\\\server\\share\\repo\\a.ts', '\\\\server\\share\\repo'], 'a.ts'],
      [
        ['\\\\server\\share\\other\\a.ts', '\\\\server\\share\\repo'],
        '\\\\server\\share\\other\\a.ts',
      ],
    ],
    'makes POSIX paths relative, case-sensitively': [
      [['/home/me/repo/src/a.ts', '/home/me/repo'], 'src/a.ts'],
      [['/home/me/Repo/src/a.ts', '/home/me/repo'], '/home/me/Repo/src/a.ts'],
    ],
    'ignores trailing and repeated separators': [
      [['/home/me/repo/src/a.ts', '/home/me/repo/'], 'src/a.ts'],
      [['/home/me/repo/src/a.ts', '/home/me/repo//'], 'src/a.ts'],
      [['/home/me/repo//src/a.ts', '/home/me/repo'], 'src/a.ts'],
      [['C:\\repo\\src\\', 'C:\\repo'], 'src'],
    ],
    'gives "." for the root itself': [
      [['/home/me/repo', '/home/me/repo'], '.'],
      [['/home/me/repo/', '/home/me/repo'], '.'],
      [['C:\\repo', 'c:\\repo\\'], '.'],
    ],
    'handles filesystem roots': [
      [['/etc/hosts', '/'], 'etc/hosts'],
      [['C:\\a\\b.txt', 'C:\\'], 'a/b.txt'],
      [['D:\\a\\b.txt', 'C:\\'], 'D:\\a\\b.txt'],
    ],
    'leaves paths outside the root as given': [
      [['/home/me/other/a.ts', '/home/me/repo'], '/home/me/other/a.ts'],
      [['/home/me/repo-two/a.ts', '/home/me/repo'], '/home/me/repo-two/a.ts'],
      [
        ['C:\\Users\\alex\\.claude\\x.md', 'C:\\Users\\alex\\repo'],
        'C:\\Users\\alex\\.claude\\x.md',
      ],
      [['D:\\repo\\a.ts', 'C:\\repo'], 'D:\\repo\\a.ts'],
    ],
    'returns the path as given without a root': [
      [['C:\\repo\\a.ts'], 'C:\\repo\\a.ts'],
      [['/repo/a.ts', null], '/repo/a.ts'],
      [['/repo/a.ts', ''], '/repo/a.ts'],
      [['/repo/a.ts', 'relative/root'], '/repo/a.ts'],
    ],
    'tidies paths that are already relative': [
      [['packages\\web\\a.ts', '/repo'], 'packages/web/a.ts'],
      [['./src/a.ts', '/repo'], 'src/a.ts'],
      [['src/a.ts'], 'src/a.ts'],
      [['./', '/repo'], '.'],
    ],
    'passes an empty path through': [[['', '/repo'], '']],
  }

  for (const [title, cases] of Object.entries(table)) {
    it(title, () => {
      for (const [args, expected] of cases)
        expect(relativePath(...args), JSON.stringify(args)).toBe(expected)
    })
  }

  it('makes worktree paths relative to the worktree', () => {
    const wt = '/home/me/.odin/worktrees/odin/item-21'
    expect(relativePath(`${wt}/packages/web/src/App.vue`, wt)).toBe('packages/web/src/App.vue')
  })
})

describe('fileName and splitPath', () => {
  it('split on either separator', () => {
    expect(fileName('C:\\repo\\src\\a.ts')).toBe('a.ts')
    expect(fileName('src/a.ts')).toBe('a.ts')
    expect(fileName('a.ts')).toBe('a.ts')
    expect(splitPath('packages/web/App.vue')).toEqual({ dir: 'packages/web/', base: 'App.vue' })
    expect(splitPath('C:\\repo\\a.ts')).toEqual({ dir: 'C:\\repo\\', base: 'a.ts' })
    expect(splitPath('App.vue')).toEqual({ dir: '', base: 'App.vue' })
    expect(splitPath('.')).toEqual({ dir: '', base: '.' })
  })
})

describe('IuFilePath', () => {
  it('shows the path relative to the root, the full path as a title', () => {
    const full = 'C:\\Users\\alex\\odin\\packages\\web\\src\\App.vue'
    const w = mount(IuFilePath, { props: { path: full, root: 'C:\\Users\\alex\\odin' } })
    expect(w.text()).toBe('packages/web/src/App.vue')
    expect(w.attributes('title')).toBe(full)
    expect(w.find('.iu-file-path__dir').text()).toBe('packages/web/src/')
    expect(w.find('.iu-file-path__base').text()).toBe('App.vue')
  })

  it('has no directory part for a bare file name', () => {
    const w = mount(IuFilePath, { props: { path: '/repo/a.ts', root: '/repo' } })
    expect(w.find('.iu-file-path__dir').exists()).toBe(false)
    expect(w.text()).toBe('a.ts')
  })
})
