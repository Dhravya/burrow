/**
 * Burrow src/toolchain — import-specifier extraction/rewriting over bun.wasm's
 * normalized transpiler output. Regex-based per CONTRACT.md §6.2 (v1); only
 * string-literal specifiers are touched, non-literal dynamic imports are left
 * alone.
 */

export interface SpecifierOccurrence {
  spec: string;
  /** start/end delimit the specifier text INSIDE the quotes. */
  start: number;
  end: number;
}

// Static forms: import ... from "x" | import "x" | export ... from "x".
// The lookbehind rejects member accesses / identifiers ending in import|export.
const staticRe = () => /(?<![.\w$])(?:import|export)\s*(?:[\w$*\s{},]*?\bfrom\s*)?(["'])([^"'\\\n]+)\1/dg;
// Dynamic form: import("x") — optionally with an options argument.
const dynamicRe = () => /(?<![.\w$])import\s*\(\s*(["'])([^"'\\\n]+)\1\s*[,)]/dg;

export function findSpecifiers(code: string): SpecifierOccurrence[] {
  const seen = new Set<string>();
  const out: SpecifierOccurrence[] = [];
  for (const re of [staticRe(), dynamicRe()]) {
    // The `d` flag populates `.indices` (typed via RegExpExecArray in ESNext lib).
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
      const spec = match[2];
      const range = match.indices?.[2];
      if (spec === undefined || range === undefined) continue;
      const key = `${range[0]}:${range[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ spec, start: range[0], end: range[1] });
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Splice replacements in from the end so earlier offsets stay valid. */
export function rewriteSpecifiers(
  code: string,
  occurrences: SpecifierOccurrence[],
  mapping: ReadonlyMap<string, string>,
): string {
  let out = code;
  for (let i = occurrences.length - 1; i >= 0; i--) {
    const occ = occurrences[i]!;
    const replacement = mapping.get(occ.spec);
    if (replacement === undefined) continue;
    out = out.slice(0, occ.start) + replacement + out.slice(occ.end);
  }
  return out;
}
