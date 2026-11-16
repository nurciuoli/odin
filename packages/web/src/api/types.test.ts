// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { ApiRequestError } from './types'

describe('ApiRequestError', () => {
  it('keeps the status', () => {
    expect(new ApiRequestError(404, 'not found').status).toBe(404)
  })
})
