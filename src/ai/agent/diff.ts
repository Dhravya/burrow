/**
 * Burrow — src/ai/agent/diff.ts
 * A tiny LCS line-diff for rendering per-edit red/green rows in the agent panel
 * and counting +adds/−dels for observations. Pure; unit-tested.
 */

export interface DiffRow {
  type: "same" | "add" | "del";
  text: string;
}

/**
 * Line-level diff via longest-common-subsequence. For pathologically large
 * inputs (product of line counts too big) we fall back to a block diff
 * (all-del then all-add) so the UI never hangs — agent files are small anyway.
 */
export function diffLines(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;

  if (n * m > 250_000) {
    return [
      ...a.map((text): DiffRow => ({ type: "del", text })),
      ...b.map((text): DiffRow => ({ type: "add", text })),
    ];
  }

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ type: "del", text: a[i]! });
      i++;
    } else {
      rows.push({ type: "add", text: b[j]! });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", text: a[i++]! });
  while (j < m) rows.push({ type: "add", text: b[j++]! });
  return rows;
}

/** Count changed lines between two texts. */
export function countDiff(oldText: string, newText: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const row of diffLines(oldText, newText)) {
    if (row.type === "add") adds++;
    else if (row.type === "del") dels++;
  }
  return { adds, dels };
}
