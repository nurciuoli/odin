import type { NotebookCell, NotebookSnapshot } from '@odin/shared/notebooks'
export interface NotebookDraft {
  base: NotebookSnapshot
  cells: NotebookCell[]
  remote: NotebookSnapshot | null
}
export const copyCells = (cells: NotebookCell[]) =>
  JSON.parse(JSON.stringify(cells)) as NotebookCell[]
export const draftDirty = (draft: NotebookDraft) =>
  JSON.stringify(draft.cells) !== JSON.stringify(draft.base.cells)
export function notebookDraft(snapshot: NotebookSnapshot): NotebookDraft {
  return { base: snapshot, cells: copyCells(snapshot.cells), remote: null }
}
/** Remote updates never overwrite locally edited source. Conflicts require an explicit choice. */
export function receiveNotebook(draft: NotebookDraft, snapshot: NotebookSnapshot): NotebookDraft {
  if (snapshot.kernel.id !== draft.base.kernel.id) return draft
  if (snapshot.revision === draft.base.revision) {
    draft.base.kernel = snapshot.kernel
    return draft
  }
  if (draftDirty(draft)) return { ...draft, remote: snapshot }
  return notebookDraft(snapshot)
}
