import type { ModelOption } from '@/components/Chat/types'
import type { MenuItem } from '@/components/Menu'

// Use the runtime's catalog, not a hard-coded list of releases. Keep aliases/custom models discoverable.
function release(model: ModelOption): { family: string; version: number } | null {
  const name = `${model.id} ${model.label}`.toLowerCase()
  const gpt = /gpt[- ](\d+)(?:[.-](\d+))?(?:[- ](sol|terra|astra|luna|codex|mini|nano))?/.exec(name)
  if (gpt)
    return {
      family: `gpt-${gpt[3] ?? 'base'}`,
      version: Number(gpt[1]) * 1000 + Number(gpt[2] ?? 0),
    }
  const claude = /(opus|sonnet|haiku)[- ](\d+)(?:[.-](\d+))?/.exec(name)
  if (claude)
    return { family: claude[1]!, version: Number(claude[2]) * 1000 + Number(claude[3] ?? 0) }
  return null
}

/** `plain` leaves out each model's description: the row is its name (and what the picker draws beside it). */
export function modelMenu(models: ModelOption[], selected?: string, plain = false): MenuItem[] {
  const latest = new Map<string, number>()
  for (const model of models) {
    const r = release(model)
    if (r) latest.set(r.family, Math.max(latest.get(r.family) ?? 0, r.version))
  }
  const primary: MenuItem[] = [],
    more: MenuItem[] = []
  for (const model of models) {
    const r = release(model)
    const older =
      /\b(older|previous[ -]generation|legacy|deprecated)\b/i.test(model.hint ?? '') ||
      (r !== null && r.version < latest.get(r.family)!)
    const item: MenuItem = {
      type: 'radio',
      id: model.id,
      label: model.label,
      ...(plain ? {} : { description: model.hint }),
      checked: model.id === selected,
    }
    ;(older ? more : primary).push(item)
  }
  if (more.length) primary.push({ id: '__more-models', label: 'More models', items: more })
  return primary
}
