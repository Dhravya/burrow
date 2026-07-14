import { describe, expect, test } from "bun:test";
import { InMemoryFs } from "just-bash/browser";
import * as git from "isomorphic-git";
import type { GitFsError } from "../contract/types.ts";
import { TypedEventBus } from "./event-bus.ts";
import { GitFsAdapter } from "./git-fs-adapter.ts";
import { WatchedFs } from "./watched-fs.ts";

function setup(initial?: ConstructorParameters<typeof InMemoryFs>[0]) {
  const bus = new TypedEventBus();
  const vfs = new WatchedFs(new InMemoryFs(initial), bus);
  const gitFs = new GitFsAdapter(vfs);
  return { vfs, gitFs, bus };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as GitFsError).code;
  }
}

describe("isPromiseFs detection contract", () => {
  test("no-arg readFile() returns a rejected promise, never throws sync", async () => {
    const { gitFs } = setup();
    let thenable: unknown;
    expect(() => {
      thenable = (gitFs as unknown as { readFile(): Promise<unknown> }).readFile();
    }).not.toThrow();
    expect(typeof (thenable as Promise<unknown>).then).toBe("function");
    expect(await codeOf(thenable as Promise<unknown>)).toBe("EINVAL");
  });
});

describe("readFile", () => {
  test("returns Uint8Array by default", async () => {
    const { gitFs } = setup({ "/f.txt": "hi" });
    const out = await gitFs.readFile("/f.txt");
    expect(out).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(out as Uint8Array)).toBe("hi");
  });

  test("honors both 'utf8' and {encoding:'utf8'}", async () => {
    const { gitFs } = setup({ "/f.txt": "héllo" });
    expect(await gitFs.readFile("/f.txt", "utf8")).toBe("héllo");
    expect(await gitFs.readFile("/f.txt", { encoding: "utf8" })).toBe("héllo");
  });

  test("ENOENT with .code on missing files", async () => {
    const { gitFs } = setup();
    expect(await codeOf(gitFs.readFile("/nope"))).toBe("ENOENT");
  });
});

describe("writeFile", () => {
  test("writes bytes and strings", async () => {
    const { gitFs, vfs } = setup();
    await gitFs.writeFile("/s.txt", "text", "utf8");
    await gitFs.writeFile("/b.bin", new Uint8Array([1, 2, 3]));
    expect(await vfs.readFile("/s.txt")).toBe("text");
    expect(await vfs.readFileBuffer("/b.bin")).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("{mode:0o777} yields an executable (0o100755) stat mode", async () => {
    const { gitFs } = setup();
    await gitFs.writeFile("/hook.sh", "#!/bin/sh", { mode: 0o777 });
    expect((await gitFs.stat("/hook.sh")).mode).toBe(0o100755);
  });

  test("auto-creates missing parents (InMemoryFs semantics — no retry dance needed)", async () => {
    const { gitFs } = setup();
    await gitFs.writeFile("/deep/ly/nested.txt", "x");
    expect(await gitFs.readFile("/deep/ly/nested.txt", "utf8")).toBe("x");
  });
});

describe("mkdir", () => {
  test("EEXIST on existing dir and on existing file", async () => {
    const { gitFs } = setup({ "/f.txt": "f", "/d/x.txt": "x" });
    expect(await codeOf(gitFs.mkdir("/d"))).toBe("EEXIST");
    expect(await codeOf(gitFs.mkdir("/f.txt"))).toBe("EEXIST");
  });

  test("ENOENT when parent is missing (drives the wrapper's mkdir -p recursion)", async () => {
    const { gitFs } = setup();
    expect(await codeOf(gitFs.mkdir("/no/parent/here"))).toBe("ENOENT");
  });

  test("creates a directory when the parent exists", async () => {
    const { gitFs, vfs } = setup();
    await gitFs.mkdir("/newdir");
    expect((await vfs.stat("/newdir")).isDirectory).toBe(true);
  });
});

describe("rmdir / unlink", () => {
  test("rmdir: ENOENT missing, ENOTDIR on file, ENOTEMPTY on populated dir", async () => {
    const { gitFs } = setup({ "/f.txt": "f", "/full/x.txt": "x" });
    expect(await codeOf(gitFs.rmdir("/missing"))).toBe("ENOENT");
    expect(await codeOf(gitFs.rmdir("/f.txt"))).toBe("ENOTDIR");
    expect(await codeOf(gitFs.rmdir("/full"))).toBe("ENOTEMPTY");
  });

  test("rmdir removes an empty directory", async () => {
    const { gitFs, vfs } = setup();
    await vfs.mkdir("/empty");
    await gitFs.rmdir("/empty");
    expect(await vfs.exists("/empty")).toBe(false);
  });

  test("unlink: ENOENT missing, EINVAL on dir, removes files", async () => {
    const { gitFs, vfs } = setup({ "/f.txt": "f", "/d/x.txt": "x" });
    expect(await codeOf(gitFs.unlink("/missing"))).toBe("ENOENT");
    expect(await codeOf(gitFs.unlink("/d"))).toBe("EINVAL");
    await gitFs.unlink("/f.txt");
    expect(await vfs.exists("/f.txt")).toBe(false);
  });

  test("unlink removes a symlink, not its target — and works on broken links", async () => {
    const { gitFs, vfs } = setup({ "/target.txt": "t" });
    await vfs.symlink("/target.txt", "/ln");
    await gitFs.unlink("/ln");
    expect(await vfs.exists("/target.txt")).toBe(true);
    await vfs.symlink("/gone", "/broken");
    await gitFs.unlink("/broken");
    expect((await gitFs.readdir("/")).includes("broken")).toBe(false);
  });
});

describe("readdir", () => {
  test("returns bare names, not paths", async () => {
    const { gitFs } = setup({ "/repo/a.txt": "a", "/repo/sub/b.txt": "b" });
    const names = await gitFs.readdir("/repo");
    expect(names.sort()).toEqual(["a.txt", "sub"]);
  });

  test("ENOTDIR on a file (GitWalkerFs depends on this), ENOENT when missing", async () => {
    const { gitFs } = setup({ "/f.txt": "f" });
    expect(await codeOf(gitFs.readdir("/f.txt"))).toBe("ENOTDIR");
    expect(await codeOf(gitFs.readdir("/zzz"))).toBe("ENOENT");
  });
});

describe("stat / lstat", () => {
  test("ENOENT with .code on missing paths", async () => {
    const { gitFs } = setup();
    expect(await codeOf(gitFs.stat("/nope"))).toBe("ENOENT");
    expect(await codeOf(gitFs.lstat("/nope"))).toBe("ENOENT");
  });

  test("full isomorphic-git stat shape: is* methods + every numeric field finite", async () => {
    const { gitFs } = setup({ "/f.txt": "hello" });
    const stat = await gitFs.stat("/f.txt");
    expect(stat.isFile()).toBe(true);
    expect(stat.isDirectory()).toBe(false);
    expect(stat.isSymbolicLink()).toBe(false);
    for (const field of ["mode", "size", "ino", "uid", "gid", "dev", "mtimeMs", "ctimeMs"] as const) {
      expect(Number.isFinite(stat[field])).toBe(true);
      // isomorphic-git normalizes each field % 2**32 — NaN here corrupts .git/index
      expect(Number.isNaN(stat[field] % 2 ** 32)).toBe(false);
    }
    expect(stat.size).toBe(5);
    expect(stat.uid).toBe(1);
    expect(stat.gid).toBe(1);
    expect(stat.dev).toBe(1);
  });

  test("modes: 0o100644 file, 0o100755 executable, 0o40755 dir, 0o120000 symlink", async () => {
    const { gitFs, vfs } = setup({ "/f.txt": "f", "/d/x.txt": "x" });
    expect((await gitFs.stat("/f.txt")).mode).toBe(0o100644);
    expect((await gitFs.stat("/d")).mode).toBe(0o40755);
    await vfs.chmod("/f.txt", 0o755);
    expect((await gitFs.stat("/f.txt")).mode).toBe(0o100755);
    await vfs.symlink("/f.txt", "/ln");
    const linkStat = await gitFs.lstat("/ln");
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(linkStat.mode).toBe(0o120000);
    // stat() follows the link
    expect((await gitFs.stat("/ln")).isFile()).toBe(true);
  });

  test("ino is stable per path and distinct across paths", async () => {
    const { gitFs, vfs } = setup({ "/a.txt": "a", "/b.txt": "b" });
    const a1 = (await gitFs.stat("/a.txt")).ino;
    const a2 = (await gitFs.stat("/a.txt")).ino;
    const a3 = (await gitFs.lstat("/a.txt")).ino;
    const b = (await gitFs.stat("/b.txt")).ino;
    expect(a1).toBe(a2);
    expect(a1).toBe(a3);
    expect(a1).not.toBe(b);
    // survives content rewrites
    await vfs.writeFile("/a.txt", "changed");
    expect((await gitFs.stat("/a.txt")).ino).toBe(a1);
    // and path spelling differences
    expect((await gitFs.stat("//a.txt")).ino).toBe(a1);
  });

  test("mtimeMs tracks the store's mtime", async () => {
    const { gitFs, vfs } = setup({ "/f.txt": "f" });
    await vfs.utimes("/f.txt", 5000, 5000);
    const stat = await gitFs.stat("/f.txt");
    expect(stat.mtimeMs).toBe(5000);
    expect(stat.ctimeMs).toBe(5000);
  });
});

describe("readlink / symlink / rm", () => {
  test("readlink returns the target; EINVAL on non-symlinks; ENOENT when missing", async () => {
    const { gitFs, vfs } = setup({ "/f.txt": "f" });
    await vfs.symlink("/f.txt", "/ln");
    expect(await gitFs.readlink("/ln")).toBe("/f.txt");
    expect(await codeOf(gitFs.readlink("/f.txt"))).toBe("EINVAL");
    expect(await codeOf(gitFs.readlink("/zzz"))).toBe("ENOENT");
  });

  test("symlink: EEXIST when the link path exists", async () => {
    const { gitFs } = setup({ "/f.txt": "f" });
    expect(await codeOf(gitFs.symlink("/anywhere", "/f.txt"))).toBe("EEXIST");
  });

  test("rm: recursive delete; force swallows ENOENT", async () => {
    const { gitFs, vfs } = setup({ "/d/a.txt": "a", "/d/sub/b.txt": "b" });
    await gitFs.rm!("/d", { recursive: true });
    expect(await vfs.exists("/d")).toBe(false);
    await gitFs.rm!("/d", { recursive: true, force: true }); // no throw
    expect(await codeOf(gitFs.rm!("/d", { recursive: true }))).toBe("ENOENT");
  });
});

// ---------------------------------------------------------------------------
// End-to-end proof: real isomorphic-git over the adapter over the shared store.
// A corrupted stat shape or wrong error code fails these loudly.
// ---------------------------------------------------------------------------

describe("isomorphic-git integration", () => {
  test("init → add → commit → log → statusMatrix → modify → checkout", async () => {
    const { gitFs: fs, vfs } = setup({
      "/repo/hello.txt": "hi\n",
      "/repo/src/lib.ts": "export const x = 1;\n",
    });
    const dir = "/repo";
    const cache = {};

    await git.init({ fs, dir, defaultBranch: "main" });
    expect(await git.currentBranch({ fs, dir })).toBe("main");

    // stage everything (array form + nested path exercises readdir/walker)
    await git.add({ fs, dir, filepath: ["hello.txt", "src/lib.ts"], cache });
    const sha = await git.commit({
      fs,
      dir,
      cache,
      message: "first",
      author: { name: "burrow", email: "burrow@localhost" },
    });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    const log = await git.log({ fs, dir, cache });
    expect(log).toHaveLength(1);
    expect(log[0]!.commit.message.trim()).toBe("first");

    // clean tree: every row [path, 1, 1, 1]
    const clean = await git.statusMatrix({ fs, dir, cache });
    expect(clean.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ["hello.txt", 1, 1, 1],
      ["src/lib.ts", 1, 1, 1],
    ]);

    // dirty it through the SHARED vfs, confirm git sees the change
    await vfs.writeFile("/repo/hello.txt", "changed\n");
    expect(await git.status({ fs, dir, filepath: "hello.txt", cache })).toBe("*modified");

    // headContent-style readBlob against the adapter
    const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
    const { blob } = await git.readBlob({ fs, dir, oid: head, filepath: "hello.txt", cache });
    expect(new TextDecoder().decode(blob)).toBe("hi\n");

    // discard via checkout (plural filepaths + force)
    await git.checkout({ fs, dir, filepaths: ["hello.txt"], force: true, cache });
    expect(await vfs.readFile("/repo/hello.txt")).toBe("hi\n");
  });

  test("second commit + deletion staged via git.remove shows in log/status", async () => {
    const { gitFs: fs, vfs } = setup({ "/repo/a.txt": "a", "/repo/b.txt": "b" });
    const dir = "/repo";
    const cache = {};
    const author = { name: "burrow", email: "burrow@localhost" };

    await git.init({ fs, dir, defaultBranch: "main" });
    await git.add({ fs, dir, filepath: ".", cache });
    await git.commit({ fs, dir, cache, message: "first", author });

    // "git add -A" pattern: workdir===0 → remove, else add
    await vfs.rm("/repo/b.txt");
    await vfs.writeFile("/repo/a.txt", "a2");
    for (const [filepath, , workdir] of await git.statusMatrix({ fs, dir, cache })) {
      if (workdir === 0) await git.remove({ fs, dir, filepath, cache });
      else await git.add({ fs, dir, filepath, cache });
    }
    await git.commit({ fs, dir, cache, message: "second", author });

    const log = await git.log({ fs, dir, cache });
    expect(log.map((e) => e.commit.message.trim())).toEqual(["second", "first"]);

    const matrix = await git.statusMatrix({ fs, dir, cache });
    expect(matrix).toEqual([["a.txt", 1, 1, 1]]); // b.txt fully gone
  });
});
