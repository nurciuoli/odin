// The app Settings form as plain data: defaults and the pricing table, what changed, and what is wrong.
import type {
  AppSettings,
  ModelPrice,
  PermissionMode,
  SettingsResponse,
  ToolName,
  UpdateSettingsRequest,
} from '@odin/shared/api'
import { TOOL_NAMES } from '@odin/shared/api'

export const DEFAULT_SHORTCUT = 'CommandOrControl+Shift+Space'

export interface PriceRow {
  model: string
  input: string
  output: string
  cacheRead: string
  cacheWrite: string
}

export interface AppForm {
  defaultHarness?: string
  harnessDefaults?: AppSettings['harnessDefaults']
  /** '' = the account default */
  defaultModel: string
  defaultPermissionMode: PermissionMode
  defaultWorktree: boolean
  notifyOnWaiting: boolean
  notifyOnFinished: boolean
  /** false = the launcher shortcut is off (saved as null) */
  shortcutOn: boolean
  launcherShortcut: string
  editorCommand: string
  /** '' = find it on PATH */
  toolPaths: Record<ToolName, string>
  pricing: PriceRow[]
}

export const PRICE_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const

export function formFromSettings(r: SettingsResponse): AppForm {
  return {
    ...(r.settings.defaultHarness ? { defaultHarness: r.settings.defaultHarness } : {}),
    ...(r.settings.harnessDefaults
      ? { harnessDefaults: structuredClone(r.settings.harnessDefaults) }
      : {}),
    defaultModel: r.settings.defaultModel ?? '',
    defaultPermissionMode: r.settings.defaultPermissionMode,
    defaultWorktree: r.settings.defaultWorktree,
    notifyOnWaiting: r.settings.notifyOnWaiting,
    notifyOnFinished: r.settings.notifyOnFinished ?? true,
    shortcutOn: r.settings.launcherShortcut !== null,
    launcherShortcut: r.settings.launcherShortcut ?? DEFAULT_SHORTCUT,
    editorCommand: r.settings.editorCommand ?? 'code',
    toolPaths: toolPathsForm(r.settings.toolPaths),
    pricing: Object.entries(r.pricing)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([model, p]) => ({
        model,
        input: String(p.input),
        output: String(p.output),
        cacheRead: String(p.cacheRead),
        cacheWrite: String(p.cacheWrite),
      })),
  }
}

export function toolPathsForm(
  paths: AppSettings['toolPaths'] | undefined,
): Record<ToolName, string> {
  return Object.fromEntries(TOOL_NAMES.map(t => [t, paths?.[t] ?? ''])) as Record<ToolName, string>
}

/** Only the overrides that are set, trimmed. */
export function toolPathsFromForm(f: Record<ToolName, string>): AppSettings['toolPaths'] {
  const out: AppSettings['toolPaths'] = {}
  for (const t of TOOL_NAMES) {
    const p = f[t]?.trim()
    if (p) out[t] = p
  }
  return out
}

/** A warning for an override Windows can't spawn without a shell (batch files), else null. */
export function toolPathWarning(path: string): string | null {
  return /\.(cmd|bat)$/i.test(path.trim())
    ? "Windows can't start .cmd or .bat files without a shell. Point at the real executable (.exe or a node script)."
    : null
}

/** A client-side check that mirrors the server: overrides must be absolute paths. */
export function toolPathError(path: string): string | null {
  const p = path.trim()
  if (!p) return null
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p)
    ? null
    : 'Use an absolute path, or leave it empty to find it on PATH.'
}

export type ToolPathErrors = Partial<Record<ToolName, string>>

export function validateToolPaths(f: Record<ToolName, string>): ToolPathErrors {
  const out: ToolPathErrors = {}
  for (const t of TOOL_NAMES) {
    const e = toolPathError(f[t] ?? '')
    if (e) out[t] = e
  }
  return out
}

export function emptyPriceRow(): PriceRow {
  return { model: '', input: '', output: '', cacheRead: '', cacheWrite: '' }
}

export type PricingErrors = Record<number, string>

/** One message per bad row index. */
export function validatePricing(rows: PriceRow[]): PricingErrors {
  const errors: PricingErrors = {}
  const seen = new Set<string>()
  rows.forEach((row, i) => {
    const model = row.model.trim()
    if (!model) errors[i] = 'Name the model.'
    else if (seen.has(model)) errors[i] = `${model} is listed twice.`
    seen.add(model)
    if (!errors[i]) {
      const bad = PRICE_FIELDS.find(k => {
        const v = row[k].trim()
        return v === '' || !Number.isFinite(Number(v)) || Number(v) < 0
      })
      if (bad) errors[i] = 'Prices are numbers, zero or more (USD per million tokens).'
    }
  })
  return errors
}

export function pricingFromRows(rows: PriceRow[]): Record<string, ModelPrice> {
  return Object.fromEntries(
    rows.map(r => [
      r.model.trim(),
      {
        input: Number(r.input),
        output: Number(r.output),
        cacheRead: Number(r.cacheRead),
        cacheWrite: Number(r.cacheWrite),
      },
    ]),
  )
}

/** Only what differs from what the server has. null = nothing to save. */
export function settingsRequest(f: AppForm, saved: SettingsResponse): UpdateSettingsRequest | null {
  const settings: Partial<AppSettings> = {}
  if (f.defaultHarness && f.defaultHarness !== (saved.settings.defaultHarness ?? 'claude'))
    settings.defaultHarness = f.defaultHarness
  if (
    f.harnessDefaults &&
    JSON.stringify(f.harnessDefaults) !== JSON.stringify(saved.settings.harnessDefaults ?? {})
  )
    settings.harnessDefaults = f.harnessDefaults
  const model = f.defaultModel || null
  if (model !== saved.settings.defaultModel) settings.defaultModel = model
  if (f.defaultPermissionMode !== saved.settings.defaultPermissionMode)
    settings.defaultPermissionMode = f.defaultPermissionMode
  if (f.defaultWorktree !== saved.settings.defaultWorktree)
    settings.defaultWorktree = f.defaultWorktree
  if (f.notifyOnWaiting !== saved.settings.notifyOnWaiting)
    settings.notifyOnWaiting = f.notifyOnWaiting
  if (f.notifyOnFinished !== (saved.settings.notifyOnFinished ?? true))
    settings.notifyOnFinished = f.notifyOnFinished
  const shortcut = f.shortcutOn ? f.launcherShortcut.trim() || null : null
  const savedShortcut =
    saved.settings.launcherShortcut === undefined
      ? DEFAULT_SHORTCUT
      : saved.settings.launcherShortcut
  if (shortcut !== savedShortcut) settings.launcherShortcut = shortcut
  const editor = f.editorCommand.trim()
  if (editor !== (saved.settings.editorCommand ?? 'code')) settings.editorCommand = editor
  const tools = toolPathsFromForm(f.toolPaths)
  if (
    JSON.stringify(tools) !==
    JSON.stringify(toolPathsFromForm(toolPathsForm(saved.settings.toolPaths)))
  )
    settings.toolPaths = tools

  const out: UpdateSettingsRequest = {}
  if (Object.keys(settings).length) out.settings = settings
  const before = JSON.stringify(formFromSettings(saved).pricing)
  if (JSON.stringify(f.pricing.slice().sort((a, b) => a.model.localeCompare(b.model))) !== before)
    out.pricing = pricingFromRows(f.pricing)
  return Object.keys(out).length ? out : null
}
