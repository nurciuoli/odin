// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { REPO_PATTERN, RESET_REQUEST, validateSetting } from './settingsForm'

describe('settings sheet validation', () => {
  it('needs a title and a default branch', () => {
    expect(validateSetting('title', '  ')).toBe('Give the project a title.')
    expect(validateSetting('title', 'Odin')).toBeUndefined()
    expect(validateSetting('defaultBranch', '')).toBe('Name the default branch.')
  })

  it('takes an empty repo (local-only) or owner/name', () => {
    expect(validateSetting('repo', '')).toBeUndefined()
    expect(validateSetting('repo', 'nurciuoli/odin')).toBeUndefined()
    expect(validateSetting('repo', 'not a repo')).toContain('owner/name')
    expect(REPO_PATTERN.test('a/b')).toBe(true)
  })

  it('reset clears every override', () => {
    expect(Object.values(RESET_REQUEST).every(v => v === null)).toBe(true)
  })
})
