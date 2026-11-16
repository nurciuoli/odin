import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuFilePath, fileName, relativePath, splitPath } from './index'

describe('relativePath', () => {
  it('makes Windows paths relative to the root, with forward slashes', () => {
    expect(
      relativePath(
        'C:\\Users\\alex\\Documents\\code\\odin\\packages\\web\\src\\App.vue',
        'C:\\Users\\alex\\Documents\\code\\odin',
      ),
    ).toBe('packages/web/src/App.vue')
  })

  it('compares Windows paths case-insensitively (drive letter and segments)', () => {
    expect(relativePath('c:\\Repo\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts')
    expect(relativePath('C:\\REPO\\src\\a.ts', 'c:\\repo\\')).toBe('src/a.ts')
  })

  it('accepts mixed separators on Windows', () => {
    expect(relativePath('C:/repo/src\\a.ts', 'C:\\repo')).toBe('src/a.ts')
    expect(relativePath('C:\\repo\\src\\a.ts', 'C:/repo/')).toBe('src/a.ts')
  })

  it('handles UNC roots', () => {
    expect(relativePath('\\\\server\\share\\repo\\a.ts', '\\\\server\\share\\repo')).toBe('a.ts')
    expect(relativePath('\\\\server\\share\\other\\a.ts', '\\\\server\\share\\repo')).toBe(
      '\\\\server\\share\\other\\a.ts',
    )
  })

  it('makes POSIX paths relative, case-sensitively', () => {
    expect(relativePath('/home/me/repo/src/a.ts', '/home/me/repo')).toBe('src/a.ts')
    expect(relativePath('/home/me/Repo/src/a.ts', '/home/me/repo')).toBe('/home/me/Repo/src/a.ts')
  })

  it('ignores trailing and repeated separators', () => {
    expect(relativePath('/home/me/repo/src/a.ts', '/home/me/repo/')).toBe('src/a.ts')
    expect(relativePath('/home/me/repo/src/a.ts', '/home/me/repo//')).toBe('src/a.ts')
    expect(relativePath('/home/me/repo//src/a.ts', '/home/me/repo')).toBe('src/a.ts')
    expect(relativePath('C:\\repo\\src\\', 'C:\\repo')).toBe('src')
  })

  it('gives "." for the root itself', () => {
    expect(relativePath('/home/me/repo', '/home/me/repo')).toBe('.')
    expect(relativePath('/home/me/repo/', '/home/me/repo')).toBe('.')
    expect(relativePath('C:\\repo', 'c:\\repo\\')).toBe('.')
  })

  it('handles filesystem roots', () => {
    expect(relativePath('/etc/hosts', '/')).toBe('etc/hosts')
    expect(relativePath('C:\\a\\b.txt', 'C:\\')).toBe('a/b.txt')
    expect(relativePath('D:\\a\\b.txt', 'C:\\')).toBe('D:\\a\\b.txt')
  })

  it('leaves paths outside the root as given', () => {
    expect(relativePath('/home/me/other/a.ts', '/home/me/repo')).toBe('/home/me/other/a.ts')
    // a sibling that shares the root as a string prefix is still outside
    expect(relativePath('/home/me/repo-two/a.ts', '/home/me/repo')).toBe('/home/me/repo-two/a.ts')
    expect(relativePath('C:\\Users\\alex\\.claude\\x.md', 'C:\\Users\\alex\\repo')).toBe(
      'C:\\Users\\alex\\.claude\\x.md',
    )
    expect(relativePath('D:\\repo\\a.ts', 'C:\\repo')).toBe('D:\\repo\\a.ts')
  })

  it('makes worktree paths relative to the worktree', () => {
    const wt = '/home/me/.odin/worktrees/odin/item-21'
    expect(relativePath(`${wt}/packages/web/src/App.vue`, wt)).toBe('packages/web/src/App.vue')
  })

  it('returns the path as given without a root', () => {
    expect(relativePath('C:\\repo\\a.ts')).toBe('C:\\repo\\a.ts')
    expect(relativePath('/repo/a.ts', null)).toBe('/repo/a.ts')
    expect(relativePath('/repo/a.ts', '')).toBe('/repo/a.ts')
    expect(relativePath('/repo/a.ts', 'relative/root')).toBe('/repo/a.ts')
  })

  it('tidies paths that are already relative', () => {
    expect(relativePath('packages\\web\\a.ts', '/repo')).toBe('packages/web/a.ts')
    expect(relativePath('./src/a.ts', '/repo')).toBe('src/a.ts')
    expect(relativePath('src/a.ts')).toBe('src/a.ts')
    expect(relativePath('./', '/repo')).toBe('.')
  })

  it('passes an empty path through', () => {
    expect(relativePath('', '/repo')).toBe('')
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
