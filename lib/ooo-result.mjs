/**
 * Public JSON outcome for a completed OOO sync. Preserve the original setToP2
 * counter while exposing named changes and their notification-compatible name.
 * @param {{created: number, deleted: number, prioritySet: number, createdNames: string[], deletedNames: string[]}} stats
 */
export function oooResult(stats) {
  return {
    created: stats.created,
    deleted: stats.deleted,
    setToP2: stats.prioritySet,
    prioritySet: stats.prioritySet,
    createdNames: [...stats.createdNames],
    deletedNames: [...stats.deletedNames]
  };
}
