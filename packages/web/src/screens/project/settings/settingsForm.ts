// A project's settings form as plain data: from a project to fields, field errors, and the PATCH body for what changed.
import type { ProjectDetail, UpdateProjectSettingsRequest } from '@odin/shared/api'

export interface SettingsForm {
  title: string
  description: string
  repo: string
  defaultBranch: string
  install: string
  check: string
  build: string
}

export type SettingsErrors = Partial<Record<keyof SettingsForm, string>>

export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function formFromProject(p: ProjectDetail): SettingsForm {
  const s = p.settings
  return {
    title: s.title,
    description: s.description,
    repo: s.repo ?? '',
    defaultBranch: s.defaultBranch,
    install: s.commands.install ?? '',
    check: s.commands.check ?? '',
    build: s.commands.build ?? '',
  }
}

export function validateSettings(f: SettingsForm): SettingsErrors {
  const errors: SettingsErrors = {}
  if (!f.title.trim()) errors.title = 'Give the project a title.'
  const repo = f.repo.trim()
  if (repo && !REPO_PATTERN.test(repo)) errors.repo = 'Use owner/name, like nurciuoli/odin.'
  if (!f.defaultBranch.trim()) errors.defaultBranch = 'Name the default branch.'
  return errors
}

/** Only what differs from the saved settings. null = nothing changed. */
export function settingsChanges(
  f: SettingsForm,
  p: ProjectDetail,
): UpdateProjectSettingsRequest | null {
  const s = p.settings
  const out: UpdateProjectSettingsRequest = {}
  if (f.title.trim() !== s.title) out.title = f.title.trim()
  if (f.description !== s.description) out.description = f.description
  const repo = f.repo.trim() || null
  if (repo !== s.repo) out.repo = repo
  if (f.defaultBranch.trim() !== s.defaultBranch) out.defaultBranch = f.defaultBranch.trim()

  const commands = { install: f.install.trim(), check: f.check.trim(), build: f.build.trim() }
  const same = (['install', 'check', 'build'] as const).every(
    k => commands[k] === (s.commands[k] ?? ''),
  )
  if (!same)
    out.commands = Object.fromEntries(Object.entries(commands).filter(([, v]) => v)) as Record<
      string,
      string
    >
  return Object.keys(out).length ? out : null
}

/** Clear every override so the project goes back to what PROJECT.md (or the defaults) say. */
export const RESET_REQUEST: UpdateProjectSettingsRequest = {
  title: null,
  description: null,
  repo: null,
  defaultBranch: null,
  commands: null,
}
