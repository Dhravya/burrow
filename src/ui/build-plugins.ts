/**
 * Burrow — bundler plugins for Bun's static/HTML-import pipeline
 * (src/ui owns; referenced from bunfig.toml [serve.static].plugins).
 */
import type { BunPlugin } from "bun";

const zlibShimPath = new URL("./zlib-shim.ts", import.meta.url).pathname;

const burrowShims: BunPlugin = {
  name: "burrow-browser-shims",
  setup(build) {
    // just-bash (browser bundle) statically imports node:zlib.
    build.onResolve({ filter: /^(node:)?zlib$/ }, () => ({ path: zlibShimPath }));
  },
};

export default burrowShims;
