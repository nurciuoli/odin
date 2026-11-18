// The row actions every Library table shares (the generic tables and the MCP servers tab), and the pure helpers
// behind them. No Vue in here.
import type { AssetKind } from '@odin/shared/api'
import { ASSET_ID_PATTERN, isInstallable } from '@odin/shared/library'
import type { MenuItem } from '@/components/Menu'

export type RowAction = 'edit' | 'install' | 'toggle' | 'duplicate' | 'export' | 'delete'

/** The ⋯ menu of a library row. Plugins export instead of duplicating; kinds that aren't installed can't be installed. */
export function assetMenu(kind: AssetKind, enabled: boolean): MenuItem[] {
  return [
    { id: 'edit', label: 'Edit', icon: 'pencil' },
    ...(isInstallable(kind)
      ? [{ id: 'install', label: 'Install in project…', icon: 'plus' } as MenuItem]
      : []),
    {
      id: 'toggle',
      label: enabled ? 'Disable' : 'Enable',
      icon: enabled ? 'pause' : 'play',
      description: enabled
        ? 'Keeps it in the Library; it can no longer be installed or used to start sessions'
        : undefined,
    },
    kind === 'plugin'
      ? { id: 'export', label: 'Export…', icon: 'external' }
      : { id: 'duplicate', label: 'Duplicate', icon: 'copy' },
    { type: 'separator' },
    { id: 'delete', label: 'Delete…', icon: 'trash', destructive: true },
  ]
}

/** A free id for a copy of `id`: `<id>-copy`, then `<id>-copy-2`, ... within the 64-character id limit. */
export function copyId(id: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '-copy' : `-copy-${n}`
    const candidate = `${id.slice(0, 64 - suffix.length).replace(/-+$/, '')}${suffix}`
    if (ASSET_ID_PATTERN.test(candidate) && !used.has(candidate)) return candidate
  }
}
