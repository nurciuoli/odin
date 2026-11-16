import type { Effort, ModelInfo } from '@odin/shared/api'
import { costTier } from './costTier'

export function effortChoices(models: ModelInfo[], model?: string | null) {
  const selected =
    models.find(m => m.value === model || m.resolved === model) ?? (!model ? models[0] : undefined)
  return (
    selected?.effortLevels?.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })) ?? []
  )
}
export function asEffort(value: string): Effort | null {
  return value ? (value as Effort) : null
}

/** What the composer's model picker needs from a catalog entry: its price bucket and effort levels. */
export function pickerExtras(m: ModelInfo) {
  const cost = costTier(m)
  const levels = m.effortLevels?.map(id => ({ id, label: id[0]!.toUpperCase() + id.slice(1) }))
  return { ...(cost ? { cost } : {}), ...(levels?.length ? { effortLevels: levels } : {}) }
}
