export type NativeValue = string | number | boolean | string[]
export interface NativeField {
  key: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external'
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  when?: { key: string; op: 'eq' | 'neq'; value: NativeValue }[]
  default?: NativeValue
  options?: { value: string; label: string; description?: string }[]
  custom?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  minItems?: number
  maxItems?: number
  placeholder?: string
  url?: string
}
export interface NativeForm {
  title: string
  fields: NativeField[]
}
export function nativeForm(value: unknown): NativeForm | null {
  if (!value || typeof value !== 'object' || !('fields' in value) || !Array.isArray(value.fields))
    return null
  return value as NativeForm
}
export function visibleField(field: NativeField, values: Record<string, NativeValue | undefined>) {
  return (
    !field.hidden &&
    (field.when ?? []).every(condition => {
      const raw = values[condition.key]
      if (raw === undefined || raw === '') return false
      const value =
        typeof condition.value === 'number' && typeof raw === 'string' ? Number(raw) : raw
      const matches = Array.isArray(value)
        ? value.includes(String(condition.value))
        : value === condition.value
      return condition.op === 'eq' ? matches : !matches
    })
  )
}
export function validateNativeForm(
  form: NativeForm,
  values: Record<string, NativeValue | undefined>,
) {
  const answer: Record<string, NativeValue> = {}
  const errors: Record<string, string> = {}
  for (const field of form.fields) {
    if (!visibleField(field, values) || field.type === 'external') continue
    const value = values[field.key]
    const missing = value === undefined || value === '' || (Array.isArray(value) && !value.length)
    if (missing) {
      if (field.required) errors[field.key] = 'An answer is required.'
      continue
    }
    if (field.type === 'number' || field.type === 'integer') {
      const number = Number(value)
      if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number)))
        errors[field.key] = field.type === 'integer' ? 'Enter a whole number.' : 'Enter a number.'
      else if (
        (field.minimum !== undefined && number < field.minimum) ||
        (field.maximum !== undefined && number > field.maximum)
      )
        errors[field.key] = 'Enter a number within the allowed range.'
      else answer[field.key] = number
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') errors[field.key] = 'Choose yes or no.'
      else answer[field.key] = value
    } else if (field.type === 'multiselect') {
      if (
        !Array.isArray(value) ||
        (field.minItems !== undefined && value.length < field.minItems) ||
        (field.maxItems !== undefined && value.length > field.maxItems)
      )
        errors[field.key] = 'Choose the required number of options.'
      else if (!field.custom && value.some(v => !field.options?.some(o => o.value === v)))
        errors[field.key] = 'Choose an available option.'
      else answer[field.key] = value
    } else if (field.type === 'string') {
      const text = String(value)
      if (
        (field.minLength !== undefined && text.length < field.minLength) ||
        (field.maxLength !== undefined && text.length > field.maxLength)
      )
        errors[field.key] = 'Check the answer length.'
      else if (field.options?.length && !field.custom && !field.options.some(o => o.value === text))
        errors[field.key] = 'Choose an available option.'
      else {
        try {
          if (field.pattern && !new RegExp(field.pattern).test(text))
            errors[field.key] = 'The answer does not match the required format.'
        } catch {
          errors[field.key] = 'This form has an unsupported validation pattern.'
        }
        if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text))
          errors[field.key] = 'Enter an email address.'
        if (field.format === 'uri') {
          try {
            new URL(text)
          } catch {
            errors[field.key] = 'Enter a complete URL.'
          }
        }
        if (
          field.format === 'date' &&
          (!/^\d{4}-\d{2}-\d{2}$/.test(text) ||
            Number.isNaN(Date.parse(text)) ||
            new Date(text).toISOString().slice(0, 10) !== text)
        )
          errors[field.key] = 'Enter a date in YYYY-MM-DD format.'
        if (
          field.format === 'date-time' &&
          (!/^\d{4}-\d{2}-\d{2}T/.test(text) || Number.isNaN(Date.parse(text)))
        )
          errors[field.key] = 'Enter a complete date and time.'
        answer[field.key] = text
      }
    } else errors[field.key] = 'This field type is not supported.'
  }
  return { answer, errors }
}
