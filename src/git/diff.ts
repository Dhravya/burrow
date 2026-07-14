/**
 * Burrow — src/git/diff.ts
 * Minimal line diff (Myers O((N+M)D)) + unified-format renderer for the
 * terminal `git diff` subcommand. isomorphic-git ships NO textual diff API
 * (diff3 internals are merge-only), so this is ours. The fancy side-by-side
 * diff lives in the UI via @codemirror/merge — this stays deliberately small.
 */

export interface DiffRecord {
  tag: " " | "-" | "+";
  line: string;
}

/** Above this many changed-region lines we fall back to whole-block replace. */
const MYERS_LIMIT = 40_000;

/** Line-level diff of two line arrays into a flat record stream. */
export function diffLines(aLines: string[], bLines: string[]): DiffRecord[] {
  // Trim common prefix/suffix first — typical edits touch a tiny region.
  let start = 0;
  while (start < aLines.length && start < bLines.length && aLines[start] === bLines[start]) start++;
  let endA = aLines.length;
  let endB = bLines.length;
  while (endA > start && endB > start && aLines[endA - 1] === bLines[endB - 1]) {
    endA--;
    endB--;
  }

  const a = aLines.slice(start, endA);
  const b = bLines.slice(start, endB);

  const middle: DiffRecord[] =
    a.length + b.length > MYERS_LIMIT
      ? [
          ...a.map((line): DiffRecord => ({ tag: "-", line })),
          ...b.map((line): DiffRecord => ({ tag: "+", line })),
        ]
      : myers(a, b);

  return [
    ...aLines.slice(0, start).map((line): DiffRecord => ({ tag: " ", line })),
    ...middle,
    ...aLines.slice(endA).map((line): DiffRecord => ({ tag: " ", line })),
  ];
}

/** Classic Myers greedy diff with backtracking trace. */
function myers(a: string[], b: string[]): DiffRecord[] {
  const N = a.length;
  const M = b.length;
  if (N === 0) return b.map((line): DiffRecord => ({ tag: "+", line }));
  if (M === 0) return a.map((line): DiffRecord => ({ tag: "-", line }));

  const max = N + M;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!)) {
        x = v[k + 1 + offset]!;
      } else {
        x = v[k - 1 + offset]! + 1;
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= N && y >= M) break outer;
    }
  }

  // Backtrack from (N, M) through the snapshots.
  const out: DiffRecord[] = [];
  let x = N;
  let y = M;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vv[k - 1 + offset]! < vv[k + 1 + offset]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = vv[prevK + offset]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      out.push({ tag: " ", line: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) out.push({ tag: "+", line: b[prevY]! });
      else out.push({ tag: "-", line: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  out.reverse();
  return out;
}

interface SplitResult {
  lines: string[];
  noEol: boolean;
}

function splitLines(text: string): SplitResult {
  if (text === "") return { lines: [], noEol: false };
  const noEol = !text.endsWith("\n");
  const lines = text.split("\n");
  if (!noEol) lines.pop();
  return { lines, noEol };
}

export interface UnifiedDiffOptions {
  /** ANSI colors (default true — this feeds the terminal). */
  color?: boolean;
  /** Context lines per hunk (default 3). */
  context?: number;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
};

function hunkRange(start: number, count: number): string {
  // git omits ",1"
  return count === 1 ? String(start) : `${start},${count}`;
}

/**
 * Render a unified diff of two file contents (null = file absent on that
 * side). Returns "" when the contents are identical. `\n` line endings.
 */
export function formatUnified(
  aText: string | null,
  bText: string | null,
  relPath: string,
  options: UnifiedDiffOptions = {},
): string {
  if (aText === bText) return "";
  const color = options.color ?? true;
  const context = options.context ?? 3;
  const paint = (code: string, s: string): string => (color ? `${code}${s}${ANSI.reset}` : s);

  const a = splitLines(aText ?? "");
  const b = splitLines(bText ?? "");
  const recs = diffLines(a.lines, b.lines);
  if (aText !== null && bText !== null && recs.every((r) => r.tag === " ")) return "";

  const aLabel = aText === null ? "/dev/null" : `a/${relPath}`;
  const bLabel = bText === null ? "/dev/null" : `b/${relPath}`;

  const out: string[] = [];
  out.push(paint(ANSI.bold, `diff --git a/${relPath} b/${relPath}`));
  if (aText === null) out.push(paint(ANSI.bold, "new file mode 100644"));
  if (bText === null) out.push(paint(ANSI.bold, "deleted file mode 100644"));
  out.push(paint(ANSI.bold, `--- ${aLabel}`));
  out.push(paint(ANSI.bold, `+++ ${bLabel}`));

  // Prefix counts of a-lines/b-lines consumed before each record index.
  const aBefore = new Array<number>(recs.length + 1);
  const bBefore = new Array<number>(recs.length + 1);
  aBefore[0] = 0;
  bBefore[0] = 0;
  for (let i = 0; i < recs.length; i++) {
    const tag = recs[i]!.tag;
    aBefore[i + 1] = aBefore[i]! + (tag === "+" ? 0 : 1);
    bBefore[i + 1] = bBefore[i]! + (tag === "-" ? 0 : 1);
  }

  // Group changed record indices into hunks (merge gaps <= 2*context).
  const changed: number[] = [];
  for (let i = 0; i < recs.length; i++) if (recs[i]!.tag !== " ") changed.push(i);
  if (changed.length === 0) {
    // Only an EOL-newline change; degenerate but still render nothing.
    return "";
  }

  interface Hunk {
    from: number;
    to: number; // record index range [from, to]
  }
  const hunks: Hunk[] = [];
  let from = changed[0]!;
  let last = changed[0]!;
  for (let ci = 1; ci < changed.length; ci++) {
    const idx = changed[ci]!;
    if (idx - last > 2 * context) {
      hunks.push({ from, to: last });
      from = idx;
    }
    last = idx;
  }
  hunks.push({ from, to: last });

  const lastAIdx = a.lines.length; // consumed-count that means "final a line rendered"
  const lastBIdx = b.lines.length;

  for (const hunk of hunks) {
    const lo = Math.max(0, hunk.from - context);
    const hi = Math.min(recs.length - 1, hunk.to + context);
    const aCount = aBefore[hi + 1]! - aBefore[lo]!;
    const bCount = bBefore[hi + 1]! - bBefore[lo]!;
    const aStart = aCount === 0 ? aBefore[lo]! : aBefore[lo]! + 1;
    const bStart = bCount === 0 ? bBefore[lo]! : bBefore[lo]! + 1;
    out.push(paint(ANSI.cyan, `@@ -${hunkRange(aStart, aCount)} +${hunkRange(bStart, bCount)} @@`));

    for (let i = lo; i <= hi; i++) {
      const rec = recs[i]!;
      const text = `${rec.tag}${rec.line}`;
      if (rec.tag === "-") out.push(paint(ANSI.red, text));
      else if (rec.tag === "+") out.push(paint(ANSI.green, text));
      else out.push(text);

      // "\ No newline at end of file" markers.
      const aDone = aBefore[i + 1]! === lastAIdx && rec.tag !== "+";
      const bDone = bBefore[i + 1]! === lastBIdx && rec.tag !== "-";
      if (rec.tag === "-" && aDone && a.noEol) out.push("\\ No newline at end of file");
      else if (rec.tag !== "-" && bDone && b.noEol && i === recs.length - 1) {
        out.push("\\ No newline at end of file");
      } else if (rec.tag === " " && aDone && a.noEol && i === recs.length - 1 && !b.noEol) {
        out.push("\\ No newline at end of file");
      }
    }
  }

  return out.join("\n") + "\n";
}
