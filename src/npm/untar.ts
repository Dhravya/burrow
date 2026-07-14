/**
 * burrow — src/npm/untar.ts
 * OWNED BY: installer agent.
 *
 * Hand-rolled streaming tar extractor for npm tarballs. Input is the tar
 * byte stream AFTER gunzip (the browser pipes the .tgz through
 * DecompressionStream("gzip"); bun tests use Bun.gunzipSync). No node:zlib,
 * no node:buffer — runs in the browser bundle.
 *
 * Format handled (POSIX ustar as npm/`npm pack` emits it):
 *   - 512-byte headers; name at 0..100, ustar `prefix` at 345..500 is
 *     prepended (`prefix + "/" + name`).
 *   - `size` / `mode` are NUL/space-terminated octal (base-256 size guarded).
 *   - typeflag: '0'/NUL = file, '5' = dir. Everything else (pax 'x'/'g',
 *     GNU 'L'/'K', links '1'/'2', devices...) is skipped INCLUDING its
 *     payload, which is 512-aligned like any other entry.
 *   - File data padded to the next 512 boundary; archive ends at the first
 *     all-zero block (two-zero-block terminator).
 *
 * npm tarballs wrap everything in one top directory (canonically `package/`,
 * but scoped/legacy packs differ) — the FIRST path segment is stripped
 * whatever it is. The entry for the top directory itself is dropped.
 */

export interface TarEntry {
  /** POSIX path relative to the package root (first segment stripped). */
  path: string;
  /** File bytes (empty for directories). A copy — safe to retain. */
  data: Uint8Array;
  /** Permission bits from the header (e.g. 0o644, 0o755). */
  mode: number;
  type: "file" | "directory";
}

const BLOCK = 512;
const decoder = new TextDecoder();

function readString(block: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const stop = offset + length;
  while (end < stop && block[end] !== 0) end++;
  return decoder.decode(block.subarray(offset, end));
}

/** NUL/space-padded octal; base-256 (high bit set) fallback for huge sizes. */
function readNumeric(block: Uint8Array, offset: number, length: number): number {
  const first = block[offset] ?? 0;
  if ((first & 0x80) !== 0) {
    // GNU base-256 encoding (never produced by npm, cheap to support).
    let value = first & 0x7f;
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + (block[i] ?? 0);
    return value;
  }
  const text = readString(block, offset, length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  return Number.isNaN(value) ? 0 : value;
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let i = offset; i < offset + BLOCK; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

/**
 * Strip the first path segment (npm's `package/` wrapper — or whatever the
 * publisher used). Returns null for the wrapper directory itself and for
 * unsafe paths (absolute or escaping via `..`).
 */
function stripFirstSegment(rawPath: string): string | null {
  const trimmed = rawPath.replace(/\/+$/, "");
  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return null; // path traversal — never valid in a package
  segments.shift(); // the wrapper dir, whatever its name
  if (segments.length === 0) return null;
  return segments.join("/");
}

/**
 * Iterate the entries of a gunzipped npm tarball. Yields files and
 * directories only; other entry types are skipped (payload included).
 * Throws on a structurally truncated archive.
 */
export function* untar(input: ArrayBuffer | Uint8Array): Generator<TarEntry, void, undefined> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let offset = 0;

  while (offset + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, offset)) break; // terminator (first of the two zero blocks)

    const block = bytes.subarray(offset, offset + BLOCK);
    const name = readString(block, 0, 100);
    const mode = readNumeric(block, 100, 8);
    const size = readNumeric(block, 124, 12);
    const typeflag = block[156] ?? 0;
    const magic = readString(block, 257, 6);
    const prefix = magic.startsWith("ustar") ? readString(block, 345, 155) : "";

    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length) {
      throw new Error(`untar: truncated archive (entry "${name}" wants ${size} bytes past EOF)`);
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    const isFile = typeflag === 0 || typeflag === 0x30 /* '0' */ || typeflag === 0x37; /* '7' */
    const isDir = typeflag === 0x35; /* '5' */
    if (!isFile && !isDir) continue; // pax x/g, GNU L/K, links, devices: payload already skipped

    const fullPath = prefix !== "" ? `${prefix}/${name}` : name;
    const path = stripFirstSegment(fullPath);
    if (path === null) continue; // the package/ wrapper itself, or unsafe

    if (isDir) {
      yield { path, data: new Uint8Array(0), mode: mode || 0o755, type: "directory" };
    } else {
      // slice() copies out of the (large) gunzip buffer so entries can be
      // retained without pinning the whole archive.
      yield { path, data: bytes.slice(dataStart, dataEnd), mode: mode || 0o644, type: "file" };
    }
  }
}
