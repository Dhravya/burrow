/**
 * burrow — src/npm/untar.test.ts (installer agent)
 * Synthetic fixtures covering the ustar corners npm tarballs exercise
 * (prefix field, pax skip, dir entries, first-segment stripping, alignment,
 * terminator) + one real registry tarball (nanoid) end-to-end.
 */

import { describe, expect, test } from "bun:test";
import { untar, type TarEntry } from "./untar.ts";

// --------------------------------------------------------------------------
// Tiny tar writer (headers per POSIX ustar)
// --------------------------------------------------------------------------

const enc = new TextEncoder();

function octal(value: number, fieldLength: number): string {
  return `${value.toString(8).padStart(fieldLength - 1, "0")}\0`;
}

interface HeaderSpec {
  name: string;
  size?: number;
  typeflag?: string; // "0" file, "5" dir, "x" pax, ...
  mode?: number;
  prefix?: string;
  magic?: string | null; // default "ustar"; null = pre-POSIX (no magic)
}

function header(spec: HeaderSpec): Uint8Array {
  const block = new Uint8Array(512);
  const put = (text: string, offset: number, length: number): void => {
    block.set(enc.encode(text).subarray(0, length), offset);
  };
  put(spec.name, 0, 100);
  put(octal(spec.mode ?? 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8); // uid
  put(octal(0, 8), 116, 8); // gid
  put(octal(spec.size ?? 0, 12), 124, 12);
  put(octal(0, 12), 136, 12); // mtime
  block.fill(0x20, 148, 156); // checksum = spaces while summing
  block[156] = (spec.typeflag ?? "0").charCodeAt(0);
  if (spec.magic !== null) {
    put(spec.magic ?? "ustar", 257, 6);
    put("00", 263, 2);
    if (spec.prefix) put(spec.prefix, 345, 155);
  }
  let sum = 0;
  for (const byte of block) sum += byte;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return block;
}

function entry(spec: HeaderSpec, content?: string | Uint8Array): Uint8Array[] {
  const data = content === undefined ? new Uint8Array(0) : typeof content === "string" ? enc.encode(content) : content;
  const blocks = [header({ ...spec, size: data.byteLength })];
  if (data.byteLength > 0) {
    const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
    padded.set(data);
    blocks.push(padded);
  }
  return blocks;
}

function tarball(...blockGroups: Uint8Array[][]): Uint8Array {
  const blocks = [...blockGroups.flat(), new Uint8Array(512), new Uint8Array(512)];
  const total = blocks.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
}

function extract(bytes: Uint8Array): TarEntry[] {
  return [...untar(bytes)];
}

// --------------------------------------------------------------------------
// Synthetic fixtures
// --------------------------------------------------------------------------

describe("untar — synthetic fixtures", () => {
  test("files + dir entries, package/ prefix stripped", () => {
    const entries = extract(
      tarball(
        entry({ name: "package/", typeflag: "5", mode: 0o755 }),
        entry({ name: "package/package.json" }, '{"name":"x","version":"1.0.0"}'),
        entry({ name: "package/lib/", typeflag: "5", mode: 0o755 }),
        entry({ name: "package/lib/index.js" }, "export default 1;\n"),
      ),
    );
    expect(entries.map((e) => [e.path, e.type])).toEqual([
      ["package.json", "file"],
      ["lib", "directory"],
      ["lib/index.js", "file"],
    ]);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe('{"name":"x","version":"1.0.0"}');
  });

  test("strips the FIRST segment whatever it is (non-'package' wrapper)", () => {
    const entries = extract(tarball(entry({ name: "nanoid-3.3.7/index.cjs" }, "module.exports = 1;")));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("index.cjs");
  });

  test("pax 'x' and 'g' entries are skipped with their (512-aligned) payloads", () => {
    const paxPayload = "27 path=package/whatever.js\n"; // deliberately not 512-aligned
    const entries = extract(
      tarball(
        entry({ name: "pax_global_header", typeflag: "g" }, paxPayload),
        entry({ name: "PaxHeader/file.js", typeflag: "x" }, paxPayload),
        entry({ name: "package/file.js" }, "ok"),
      ),
    );
    expect(entries.map((e) => e.path)).toEqual(["file.js"]);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe("ok");
  });

  test("ustar prefix field is prepended to the name", () => {
    const entries = extract(
      tarball(entry({ name: "deep/nested/file.txt", prefix: "package/very" }, "deep content")),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.path).toBe("very/deep/nested/file.txt");
    expect(new TextDecoder().decode(entries[0]!.data)).toBe("deep content");
  });

  test("modes survive; executables keep their bits", () => {
    const entries = extract(
      tarball(
        entry({ name: "package/bin/cli.js", mode: 0o755 }, "#!/usr/bin/env node\n"),
        entry({ name: "package/plain.txt", mode: 0o644 }, "text"),
      ),
    );
    expect(entries[0]!.mode & 0o111).not.toBe(0);
    expect(entries[1]!.mode & 0o111).toBe(0);
  });

  test("file data is 512-aligned: multi-block file followed by another entry", () => {
    const big = "a".repeat(513); // spills into a second data block
    const entries = extract(
      tarball(entry({ name: "package/big.txt" }, big), entry({ name: "package/after.txt" }, "after")),
    );
    expect(entries.map((e) => e.path)).toEqual(["big.txt", "after.txt"]);
    expect(entries[0]!.data.byteLength).toBe(513);
    expect(new TextDecoder().decode(entries[1]!.data)).toBe("after");
  });

  test("symlink/hardlink entries are ignored", () => {
    const entries = extract(
      tarball(
        entry({ name: "package/real.js" }, "x"),
        entry({ name: "package/link.js", typeflag: "2" }), // symlink, no payload
        entry({ name: "package/hard.js", typeflag: "1" }), // hardlink, no payload
      ),
    );
    expect(entries.map((e) => e.path)).toEqual(["real.js"]);
  });

  test("stops at the two-zero-block terminator; trailing junk ignored", () => {
    const clean = tarball(entry({ name: "package/a.txt" }, "a"));
    const withJunk = new Uint8Array(clean.byteLength + 1024);
    withJunk.set(clean);
    withJunk.fill(0xff, clean.byteLength); // garbage after the terminator
    const entries = extract(withJunk);
    expect(entries.map((e) => e.path)).toEqual(["a.txt"]);
  });

  test("path traversal entries are dropped", () => {
    const entries = extract(
      tarball(entry({ name: "package/../../etc/passwd" }, "evil"), entry({ name: "package/safe.txt" }, "ok")),
    );
    expect(entries.map((e) => e.path)).toEqual(["safe.txt"]);
  });

  test("truncated archive throws", () => {
    const clean = tarball(entry({ name: "package/a.txt" }, "a".repeat(600)));
    const truncated = clean.subarray(0, 512 + 100); // header + partial data
    expect(() => extract(truncated as Uint8Array)).toThrow(/truncated/);
  });

  test("accepts ArrayBuffer input", () => {
    const bytes = tarball(entry({ name: "package/a.txt" }, "ab"));
    const copy = bytes.slice().buffer;
    const entries = [...untar(copy)];
    expect(entries[0]!.path).toBe("a.txt");
  });
});

// --------------------------------------------------------------------------
// Real registry tarball
// --------------------------------------------------------------------------

describe("untar — real npm tarball (nanoid)", () => {
  test("extracts nanoid-3.3.7.tgz from the registry", async () => {
    const response = await fetch("https://registry.npmjs.org/nanoid/-/nanoid-3.3.7.tgz");
    expect(response.ok).toBe(true);
    const tgz = new Uint8Array(await response.arrayBuffer());
    const entries = [...untar(Bun.gunzipSync(tgz))];

    expect(entries.length).toBeGreaterThan(5);
    for (const e of entries) {
      expect(e.path.startsWith("package/")).toBe(false);
      expect(e.path.startsWith("/")).toBe(false);
    }

    const pkgJson = entries.find((e) => e.path === "package.json");
    expect(pkgJson).toBeDefined();
    const manifest = JSON.parse(new TextDecoder().decode(pkgJson!.data)) as { name: string; version: string };
    expect(manifest.name).toBe("nanoid");
    expect(manifest.version).toBe("3.3.7");

    const cli = entries.find((e) => e.path === "bin/nanoid.cjs");
    expect(cli).toBeDefined();
  }, 30_000);
});
