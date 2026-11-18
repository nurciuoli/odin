// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@odin/shared/harness'
import {
  mergeCommands,
  odinCommands,
  parseOdinCommand,
  resolveModel,
  toComposerCommands,
} from './slashCommands'

const harness: SlashCommand[] = [
  { name: 'clear', description: 'Harness clear', argumentHint: '', source: 'builtin' },
  { name: 'new', description: 'Claimed by an alias', argumentHint: '', source: 'custom' },
  { name: 'compact', description: 'Compact', argumentHint: '<instructions>', source: 'builtin' },
]

describe('odin slash commands', () => {
  it('offers /model only where there is a model menu', () => {
    expect(odinCommands({ model: true }).map(c => c.name)).toEqual([
      'clear',
      'model',
      'rename',
      'btw',
      'send',
      'handoff',
      'status',
      'cost',
    ])
    expect(odinCommands({ model: false }).map(c => c.name)).toEqual([
      'clear',
      'rename',
      'btw',
      'send',
      'handoff',
      'status',
      'cost',
    ])
  })

  it('takes precedence over harness commands by name and alias', () => {
    const merged = mergeCommands(odinCommands({ model: false }), harness)
    expect(merged.map(c => `${c.source}:${c.name}`)).toEqual([
      'odin:clear',
      'odin:rename',
      'odin:btw',
      'odin:send',
      'odin:handoff',
      'odin:status',
      'odin:cost',
      'builtin:compact',
    ])
  })

  it('maps to composer commands with groups and hints', () => {
    const [clear, compact] = toComposerCommands([odinCommands({ model: false })[0]!, harness[2]!])
    expect(clear).toMatchObject({ name: 'clear', group: 'Odin', aliases: ['reset', 'new'] })
    expect(compact).toMatchObject({ group: 'Built-in', argumentHint: '<instructions>' })
  })

  it('parses its commands and aliases, and leaves everything else to be sent', () => {
    const own = odinCommands({ model: true })
    expect(parseOdinCommand('/reset', own)).toEqual({ name: 'clear', arg: '' })
    expect(parseOdinCommand('/rename  New title ', own)).toEqual({
      name: 'rename',
      arg: 'New title',
    })
    expect(parseOdinCommand('/model opus', own)).toEqual({ name: 'model', arg: 'opus' })
    expect(parseOdinCommand('/now check the logs', own)).toEqual({
      name: 'send',
      arg: 'check the logs',
    })
    expect(parseOdinCommand('/compact', own)).toBeNull()
    expect(parseOdinCommand('please /clear', own)).toBeNull()
    expect(parseOdinCommand('/model x', odinCommands({ model: false }))).toBeNull()
  })

  it('resolves a model by id, name or resolved id', () => {
    const models = [{ value: 'opus', displayName: 'Opus', resolved: 'claude-opus-5' }]
    expect(resolveModel('Opus', models)).toBe('opus')
    expect(resolveModel('claude-opus-5', models)).toBe('opus')
    expect(resolveModel('other', models)).toBe('other')
    expect(resolveModel(' ', models)).toBeNull()
  })
})

it('offers effort choices only for models supporting effort and claims the native command', () => {
  const own = odinCommands({ model: true, effort: ['low', 'high'] })
  expect(own.find(c => c.name === 'effort')?.choices?.map(c => c.insert)).toEqual([
    'default',
    'low',
    'high',
  ])
  expect(parseOdinCommand('/effort high', own)).toEqual({ name: 'effort', arg: 'high' })
  expect(odinCommands({ model: true }).some(c => c.name === 'effort')).toBe(false)
  expect(
    mergeCommands(own, [
      { name: 'effort', source: 'builtin', description: '', argumentHint: '' },
    ]).filter(c => c.name === 'effort'),
  ).toHaveLength(1)
})
