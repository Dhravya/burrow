/**
 * Burrow — node:zlib shim (src/ui owns; wired via bunfig.toml + build-plugins.ts).
 * just-bash's browser bundle statically imports node:zlib; only the
 * gzip/gunzip/zcat commands actually reach it. They throw here — everything
 * else keeps working (CONTRACT.md §9).
 */

function unavailable(): never {
  throw new Error("zlib is unavailable in Burrow — gzip/gunzip/zcat are disabled in the browser");
}

export function gzipSync(): never {
  return unavailable();
}
export function gunzipSync(): never {
  return unavailable();
}
export function deflateSync(): never {
  return unavailable();
}
export function inflateSync(): never {
  return unavailable();
}
export function deflateRawSync(): never {
  return unavailable();
}
export function inflateRawSync(): never {
  return unavailable();
}
export function brotliCompressSync(): never {
  return unavailable();
}
export function brotliDecompressSync(): never {
  return unavailable();
}
export function gzip(): never {
  return unavailable();
}
export function gunzip(): never {
  return unavailable();
}

export const constants: Record<string, number> = {};

export default {
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  deflateRawSync,
  inflateRawSync,
  brotliCompressSync,
  brotliDecompressSync,
  gzip,
  gunzip,
  constants,
};
