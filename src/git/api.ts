/**
 * Burrow — src/git/api.ts
 * GitAPI implementation: isomorphic-git 1.38.7 over the shared "gitFs"
 * adapter from the registry, http from isomorphic-git/http/web, same-origin
 * /git-proxy CORS proxy. See CONTRACT.md §7.
 */
import "./polyfill.ts";

import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";

import { use } from "../contract/registry.ts";
import { GIT_PROXY_PREFIX, WORKSPACE_ROOT } from "../contract/types.ts";
import type {
  EventBus,
  GitAPI,
  GitAuthor,
  GitFsPromises,
  GitLogEntry,
  GitStatusRow,
} from "../contract/types.ts";

/**
 * isomorphic-git's d.ts only names the `{ promises: {...} }` shape, but the
 * runtime detects (and the contract mandates) the FLAT promise-style fs.
 * The cast is confined to this accessor.
 */
type IsoGitFs = Parameters<typeof git.statusMatrix>[0]["fs"];

const DEFAULT_AUTHOR: GitAuthor = { name: "burrow", email: "burrow@localhost" };

/**
 * Optional dependency injection (tests). Production callers (initGit) pass
 * nothing and both resolve lazily through the registry.
 */
export interface GitApiDeps {
  gitFs?: GitFsPromises;
  events?: EventBus;
}

export function createGitApi(deps: GitApiDeps = {}): GitAPI {
  let author: GitAuthor = { ...DEFAULT_AUTHOR };

  /** One shared cache object per repo dir (big perf win for status/log/readBlob). */
  const caches = new Map<string, object>();
  const cacheFor = (dir: string): object => {
    let cache = caches.get(dir);
    if (!cache) {
      cache = {};
      caches.set(dir, cache);
    }
    return cache;
  };

  const fs = (): IsoGitFs => (deps.gitFs ?? use("gitFs")) as unknown as IsoGitFs;
  const emitBatch = (): void => (deps.events ?? use("events")).emit("fs:batch", { reason: "git" });

  const api: GitAPI = {
    async clone(options) {
      const dir = options.dir ?? WORKSPACE_ROOT;
      // Throwaway cache: clone caches are huge; a fresh one serves status/log.
      const cloneCache = {};
      try {
        await git.clone({
          fs: fs(),
          http,
          dir,
          cache: cloneCache,
          url: options.url,
          corsProxy: GIT_PROXY_PREFIX,
          singleBranch: options.singleBranch ?? true,
          depth: options.depth ?? 1,
          noTags: options.noTags ?? true,
          onProgress: options.onProgress
            ? (p) => {
                options.onProgress!({ phase: p.phase, loaded: p.loaded, total: p.total });
              }
            : undefined,
          onMessage: options.onMessage
            ? (m) => {
                options.onMessage!(m);
              }
            : undefined,
          onAuth: options.onAuth ? async (url) => await options.onAuth!(url) : undefined,
        });
      } finally {
        caches.delete(dir); // release clone-era RAM; later calls mint a fresh cache
        emitBatch();
      }
    },

    async init(dir = WORKSPACE_ROOT) {
      await git.init({ fs: fs(), dir, defaultBranch: "main" });
      emitBatch();
    },

    async statusMatrix(dir = WORKSPACE_ROOT) {
      const rows = await git.statusMatrix({ fs: fs(), dir, cache: cacheFor(dir) });
      return rows as GitStatusRow[];
    },

    async status(filepath, dir = WORKSPACE_ROOT) {
      return await git.status({ fs: fs(), dir, filepath, cache: cacheFor(dir) });
    },

    async stage(filepath, dir = WORKSPACE_ROOT) {
      await git.add({ fs: fs(), dir, filepath, cache: cacheFor(dir) });
    },

    async stageAll(dir = WORKSPACE_ROOT) {
      const rows = await api.statusMatrix(dir);
      const cache = cacheFor(dir);
      const toAdd: string[] = [];
      for (const [filepath, head, workdir, stage] of rows) {
        if (head === 1 && workdir === 1 && stage === 1) continue; // clean
        if (workdir === 0) {
          // git.add never stages deletions — remove() is the "-A" half.
          await git.remove({ fs: fs(), dir, filepath, cache });
        } else {
          toAdd.push(filepath);
        }
      }
      if (toAdd.length > 0) {
        await git.add({ fs: fs(), dir, filepath: toAdd, cache });
      }
    },

    async unstageDelete(filepath, dir = WORKSPACE_ROOT) {
      await git.remove({ fs: fs(), dir, filepath, cache: cacheFor(dir) });
    },

    async commit(message, commitAuthor, dir = WORKSPACE_ROOT) {
      const who = commitAuthor ?? author;
      // NEVER commit without an explicit author (MissingNameError otherwise).
      return await git.commit({
        fs: fs(),
        dir,
        cache: cacheFor(dir),
        message,
        author: {
          name: who.name,
          email: who.email,
          timestamp: who.timestamp,
          timezoneOffset: who.timezoneOffset,
        },
      });
    },

    async log(options = {}) {
      const dir = options.dir ?? WORKSPACE_ROOT;
      const entries = await git.log({
        fs: fs(),
        dir,
        depth: options.depth,
        cache: cacheFor(dir),
      });
      return entries.map(
        (entry): GitLogEntry => ({
          oid: entry.oid,
          message: entry.commit.message,
          parent: entry.commit.parent,
          author: {
            name: entry.commit.author.name,
            email: entry.commit.author.email,
            timestamp: entry.commit.author.timestamp,
            timezoneOffset: entry.commit.author.timezoneOffset,
          },
        }),
      );
    },

    async currentBranch(dir = WORKSPACE_ROOT) {
      const branch = await git.currentBranch({ fs: fs(), dir });
      return branch ?? undefined;
    },

    async headContent(filepath, dir = WORKSPACE_ROOT) {
      try {
        const oid = await git.resolveRef({ fs: fs(), dir, ref: "HEAD" });
        const { blob } = await git.readBlob({ fs: fs(), dir, oid, filepath, cache: cacheFor(dir) });
        return blob;
      } catch (error) {
        // Path absent in HEAD, or HEAD unborn (fresh init) — both mean "no HEAD content".
        if (error instanceof git.Errors.NotFoundError) return null;
        throw error;
      }
    },

    async discard(filepaths, dir = WORKSPACE_ROOT) {
      await git.checkout({ fs: fs(), dir, filepaths, force: true, cache: cacheFor(dir) });
      emitBatch();
    },

    setAuthor(next) {
      author = { ...next };
    },

    getAuthor() {
      return { ...author };
    },
  };

  return api;
}
