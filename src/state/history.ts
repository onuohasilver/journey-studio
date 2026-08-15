// ---- Undo / redo ----
//
// Snapshots, not inverse commands. A journey is small — tens of nodes — so
// keeping whole copies is cheap, and it is the only approach that cannot drift:
// an inverse-op scheme has to get every operation's mirror exactly right, and
// the day one is wrong the canvas quietly diverges from what the user saw.
//
// Each entry stores the state *before* a change, plus a label, so the UI can
// offer "Undo add step" rather than a bare arrow.

export interface HistoryEntry<T> {
  snapshot: T;
  label: string;
  at: number;
  /**
   * Consecutive changes sharing a key inside the coalesce window collapse into
   * one entry. Without it, typing a URL into the inspector leaves one undo step
   * per keystroke and undo becomes unusable.
   */
  coalesceKey?: string;
}

export interface History<T> {
  push(previous: T, label: string, coalesceKey?: string): void;
  undo(current: T): {state: T; label: string} | undefined;
  redo(current: T): {state: T; label: string} | undefined;
  canUndo(): boolean;
  canRedo(): boolean;
  /** What the next undo/redo would do, for button titles. */
  peek(): {undo?: string; redo?: string};
  clear(): void;
  size(): {past: number; future: number};
}

export const COALESCE_MS = 700;

export function createHistory<T>(limit = 50): History<T> {
  let past: HistoryEntry<T>[] = [];
  let future: HistoryEntry<T>[] = [];

  return {
    push(previous, label, coalesceKey) {
      const top = past[past.length - 1];
      const now = Date.now();

      // Same field, still typing: the snapshot already on the stack is the one
      // to come back to, so refresh its recency and keep it.
      if (coalesceKey && top?.coalesceKey === coalesceKey && now - top.at < COALESCE_MS) {
        top.at = now;
        future = [];
        return;
      }

      past.push({snapshot: previous, label, at: now, coalesceKey});
      if (past.length > limit) past = past.slice(past.length - limit);
      // Any new change invalidates the redo branch.
      future = [];
    },

    undo(current) {
      const entry = past.pop();
      if (!entry) return undefined;
      future.push({...entry, snapshot: current});
      return {state: entry.snapshot, label: entry.label};
    },

    redo(current) {
      const entry = future.pop();
      if (!entry) return undefined;
      past.push({...entry, snapshot: current});
      return {state: entry.snapshot, label: entry.label};
    },

    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    peek: () => ({
      undo: past[past.length - 1]?.label,
      redo: future[future.length - 1]?.label,
    }),
    clear() {
      past = [];
      future = [];
    },
    size: () => ({past: past.length, future: future.length}),
  };
}
