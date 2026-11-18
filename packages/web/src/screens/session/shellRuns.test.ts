import { describe, expect, it } from 'vitest'
import { parseShellCommand, shellContext, withShellContext } from './shellRuns'

const run = (over = {}) => ({
  command: 'git status',
  cwd: '/p',
  output: 'clean\n',
  exitCode: 0,
  timedOut: false,
  truncated: false,
  durationMs: 5,
  ...over,
})

describe('shell mode', () => {
  it('parses a leading !', () => {
    expect(parseShellCommand('!git status')).toBe('git status')
    expect(parseShellCommand('  ! ls -la ')).toBe('ls -la')
    expect(parseShellCommand('!')).toBe('')
    expect(parseShellCommand('hello !x')).toBeNull()
    expect(parseShellCommand('/clear')).toBeNull()
  })
  it('formats runs ahead of the message', () => {
    expect(withShellContext('why?', [run({ exitCode: 1, output: 'boom' })])).toBe(
      '<shell-run cwd="/p" status="exit 1">\n$ git status\nboom\n</shell-run>\n\nwhy?',
    )
    expect(withShellContext('hi', [])).toBe('hi')
    expect(shellContext([run({ timedOut: true, exitCode: null, truncated: true })])).toContain(
      'status="timed out"',
    )
    expect(shellContext([run({ truncated: true })])).toContain('[output truncated]')
  })
})
