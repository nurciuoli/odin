import type { NotebookCell, NotebookSnapshot } from '@odin/shared/notebooks'
export interface NotebookDraft {
  base: NotebookSnapshot
  cells: NotebookCell[]
  remote: NotebookSnapshot | null
}
export const copyCells = (cells: NotebookCell[]) =>
  JSON.parse(JSON.stringify(cells)) as NotebookCell[]
const text = (source: string) => source.replace(/\r\n/g, '\n')
const sameText = (a: NotebookCell, b: NotebookCell) =>
  a.kind === b.kind && text(a.source) === text(b.source)
/** Only what the user can edit counts: the cell list, kinds and source. Outputs belong to the kernel. */
export const draftDirty = (draft: NotebookDraft) =>
  draft.cells.length !== draft.base.cells.length ||
  draft.cells.some((cell, i) => {
    const base = draft.base.cells[i]!
    return cell.id !== base.id || !sameText(cell, base)
  })
export function notebookDraft(snapshot: NotebookSnapshot): NotebookDraft {
  return { base: snapshot, cells: copyCells(snapshot.cells), remote: null }
}
/**
 * Remote updates never overwrite locally edited source; a real conflict needs an explicit choice. A running kernel
 * only rewrites outputs and execution counts, which the draft takes without comment.
 */
export function receiveNotebook(draft: NotebookDraft, snapshot: NotebookSnapshot): NotebookDraft {
  if (snapshot.kernel.id !== draft.base.kernel.id) return draft
  if (snapshot.revision === draft.base.revision) {
    draft.base.kernel = snapshot.kernel
    return draft
  }
  if (!draftDirty(draft)) return notebookDraft(snapshot)
  const base = new Map(draft.base.cells.map(cell => [cell.id, cell]))
  const mine = new Map(draft.cells.map(cell => [cell.id, cell]))
  const sameShape =
    snapshot.cells.length === draft.base.cells.length &&
    snapshot.cells.every((cell, i) => cell.id === draft.base.cells[i]!.id)
  const conflict =
    !sameShape ||
    snapshot.cells.some(cell => {
      const was = base.get(cell.id)!
      const local = mine.get(cell.id)
      return !sameText(cell, was) && !(local && sameText(cell, local))
    })
  if (conflict) return { ...draft, remote: snapshot }
  const theirs = new Map(snapshot.cells.map(cell => [cell.id, cell]))
  const cells = draft.cells.map(cell => {
    const remote = theirs.get(cell.id)
    return remote
      ? { ...cell, outputs: remote.outputs, executionCount: remote.executionCount }
      : cell
  })
  return { base: snapshot, cells: copyCells(cells), remote: null }
}
