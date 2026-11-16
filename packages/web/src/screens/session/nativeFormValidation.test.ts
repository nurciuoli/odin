// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { validateNativeForm, visibleField, type NativeForm } from './nativeForm'
describe('native form values', () => {
  const form: NativeForm = {
    title: 'Settings',
    fields: [
      { key: 'enabled', type: 'boolean', required: true },
      {
        key: 'count',
        type: 'integer',
        required: true,
        minimum: 1,
        maximum: 4,
        when: [{ key: 'enabled', op: 'eq', value: true }],
      },
      { key: 'name', type: 'string', required: true, minLength: 2 },
      {
        key: 'choices',
        type: 'multiselect',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
        ],
        minItems: 1,
        maxItems: 2,
      },
      { key: 'hidden', type: 'string', hidden: true, required: true },
      { key: 'external', type: 'external', url: 'https://example.com' },
    ],
  }
  it('coerces numbers, preserves false and arrays, and excludes hidden and conditional fields', () => {
    expect(
      validateNativeForm(form, {
        enabled: true,
        count: '2',
        name: 'Alex',
        choices: ['a'],
        hidden: 'secret',
      }),
    ).toEqual({ answer: { enabled: true, count: 2, name: 'Alex', choices: ['a'] }, errors: {} })
    expect(
      validateNativeForm(form, { enabled: false, count: 'invalid', name: 'Alex', choices: ['b'] }),
    ).toEqual({ answer: { enabled: false, name: 'Alex', choices: ['b'] }, errors: {} })
    expect(
      visibleField(
        { key: 'x', type: 'string', when: [{ key: 'enabled', op: 'neq', value: false }] },
        { enabled: false },
      ),
    ).toBe(false)
  })
  it('rejects invalid numeric, required and option values', () => {
    const { errors } = validateNativeForm(form, {
      enabled: true,
      count: '1.5',
      name: '',
      choices: ['other'],
    })
    expect(errors).toEqual({
      count: 'Enter a whole number.',
      name: 'An answer is required.',
      choices: 'Choose an available option.',
    })
  })
})
