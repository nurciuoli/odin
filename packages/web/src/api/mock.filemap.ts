// Sample file map for the mock API: a small dispatch monorepo with a working-tree diff.
import type { ProjectFileMap } from '@odin/shared/api'

type Entry = [path: string, size: number, diff?: [added: number, removed: number, lines: number]]

const ENTRIES: Entry[] = [
  ['package.json', 718],
  ['turbo.json', 1543],
  ['apps/web/src/routes/board.tsx', 8600, [22, 4, 48]],
  ['apps/web/src/routes/shipment.tsx', 7200],
  ['apps/web/src/routes/settings.tsx', 1580],
  ['apps/web/src/components/Board.tsx', 24000, [18, 47, 140]],
  ['apps/web/src/components/ShipmentRow.tsx', 5600],
  ['apps/web/src/components/StatusPill.tsx', 6185, [3, 2, 40]],
  ['apps/web/src/components/MapPane.tsx', 14000, [0, 160, 160]],
  ['apps/web/src/lib/api.ts', 9800],
  ['apps/web/src/lib/format.ts', 4142],
  ['apps/web/tests/board.test.tsx', 1450],
  ['apps/api/src/routes/shipments.ts', 21000, [54, 11, 90]],
  ['apps/api/src/routes/drivers.ts', 7400],
  ['apps/api/src/routes/webhooks.ts', 9000, [6, 31, 70]],
  ['apps/api/src/lib/db.ts', 4600],
  ['apps/api/src/lib/auth.ts', 5200],
  ['apps/api/tests/shipments.test.ts', 3563],
  ['apps/worker/src/jobs/assign.ts', 8000, [24, 7, 55]],
  ['apps/worker/src/jobs/notify.ts', 4200],
  ['apps/worker/src/jobs/geocode.ts', 5100],
  ['packages/ui/Button.tsx', 6438],
  ['packages/ui/tokens.ts', 5048],
  ['packages/domain/shipment.ts', 6400],
  ['packages/domain/status.ts', 11000, [28, 22, 60]],
  ['db/schema.sql', 52000, [86, 24, 220]],
  ['db/seed.sql', 18000],
  ['db/migrations/004_events.sql', 8100, [64, 0, 64]],
  ['infra/docker-compose.yml', 7800],
  ['infra/ci.yml', 6000, [9, 2, 40]],
  ['infra/fly.toml', 3000, [0, 36, 36]],
  ['docs/README.md', 12000],
  ['docs/adr/002-status-machine.md', 7000, [40, 0, 40]],
  ['docs/runbook.md', 8400],
]

export const MOCK_FILE_MAP: ProjectFileMap = {
  truncated: false,
  files: ENTRIES.map(([path, size, diff]) => ({
    path,
    size,
    lines: diff ? diff[2] : Math.max(1, Math.round(size / 32)),
    ...(diff ? { added: diff[0], removed: diff[1] } : {}),
  })),
}

/** Placeholder file contents for the mock API: a header and a few lines, sized loosely by the file's line count. */
export function mockFileText(path: string): string {
  const file = MOCK_FILE_MAP.files.find(f => f.path === path)
  const n = Math.min(file?.lines ?? 8, 40)
  const body = Array.from({ length: n }, (_, i) => `line ${i + 1}`)
  return [`// ${path}`, '// (sample contents from the mock API)', '', ...body, ''].join('\n')
}
