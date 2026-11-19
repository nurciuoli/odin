// Validation for the settings sheet's rows, and the request that clears every override.
import type { UpdateProjectSettingsRequest } from '@odin/shared/api'

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** The reason a row's value can't be saved, or undefined. Empty is fine only where it clears an override. */
export function validateSetting(
  field: 'title' | 'repo' | 'defaultBranch',
  value: string,
): string | undefined {
  const v = value.trim()
  if (field === 'title' && !v) return 'Give the project a title.'
  if (field === 'defaultBranch' && !v) return 'Name the default branch.'
  if (field === 'repo' && v && !REPO_PATTERN.test(v)) return 'Use owner/name, like nurciuoli/odin.'
  return undefined
}

/** Clear every override so the project goes back to what PROJECT.md (or the defaults) say. */
export const RESET_REQUEST: UpdateProjectSettingsRequest = {
  title: null,
  description: null,
  repo: null,
  defaultBranch: null,
  commands: null,
}
