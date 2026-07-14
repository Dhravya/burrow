/**
 * Burrow — src/git/git.test.ts
 * Node-free verification of the git module under `bun test`:
 *  - GitAPI + `git` command flow over a test-only in-memory GitFsPromises
 *    (init → status → add → commit → log → diff → checkout → branch → -A).
 *  - diff.ts unit checks.
 *  - proxy.ts unit checks + real end-to-end shallow clone through a local
 *    Bun.serve mounting createGitProxyRoute (network required).
 *
 * The browser-side definition of done (clone via the UI) still applies; this
 * file proves the same code paths outside the DOM.
 */
import { afterAll, expect, test } from "bun:test";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";

import type {
  BurrowEventMap,
  BurrowVfs,
  CommandContext,
  EventBus,
  GitFsPromises,
  GitFsStats,
} from "../contract/types.ts";
import { createGitApi } from "./api.ts";
import { diffLines, formatUnified } from "./diff.ts";
import { createGitProxyRoute } from "./proxy-route.ts";
import { handleGitProxy, isBlockedUpstreamHostname } from "./proxy.ts";

// ---------------------------------------------------------------------------
// Test-only in-memory fs implementing the GitFsPromises contract
// ---------------------------------------------------------------------------

type Inode =
  | { kind: "file"; data: Uint8Array; mode: number; ino: number; mtimeMs: number; ctimeMs: number }
  | { kind: "dir"; children: Map<string, Inode>; ino: number; mtimeMs: number; ctimeMs: number }
  | { kind: "symlink"; target: string; ino: number; mtimeMs: number; ctimeMs: number };

function fsError(code: string, msg: string): Error & { code: string } {
  const e = new Error(`${code}: ${msg}`) as Error & { code: string };
  e.code = code;
  return e;
}

let inoCounter = 1;
const root: Inode = { kind: "dir", children: new Map(), ino: inoCounter++, mtimeMs: Date.now(), ctimeMs: Date.now() };

function parts(p: string): string[] {
  return p.split("/").filter((s) => s.length > 0 && s !== ".");
}

function lookup(p: string): Inode {
  let node = root;
  for (const seg of parts(p)) {
    if (node.kind !== "dir") throw fsError("ENOTDIR", `not a directory, '${p}'`);
    const next = node.children.get(seg);
    if (!next) throw fsError("ENOENT", `no such file or directory, '${p}'`);
    node = next;
  }
  return node;
}

function lookupParent(p: string): { dir: Extract<Inode, { kind: "dir" }>; name: string } {
  const segs = parts(p);
  const name = segs.pop();
  if (!name) throw fsError("EINVAL", `bad path ${p}`);
  const parent = lookup("/" + segs.join("/"));
  if (parent.kind !== "dir") throw fsError("ENOTDIR", `not a directory, '${p}'`);
  return { dir: parent, name };
}

function statsFor(node: Inode): GitFsStats {
  return {
    ino: node.ino,
    mode: node.kind === "dir" ? 0o40755 : node.kind === "symlink" ? 0o120000 : node.mode,
    size: node.kind === "file" ? node.data.byteLength : node.kind === "symlink" ? node.target.length : 0,
    mtimeMs: node.mtimeMs,
    ctimeMs: node.ctimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => node.kind === "file",
    isDirectory: () => node.kind === "dir",
    isSymbolicLink: () => node.kind === "symlink",
  };
}

const testFs: GitFsPromises = {
  async readFile(path, options) {
    const node = lookup(path);
    if (node.kind !== "file") throw fsError(node.kind === "dir" ? "EISDIR" : "EINVAL", `read '${path}'`);
    const enc = typeof options === "string" ? options : options?.encoding;
    return enc === "utf8" ? new TextDecoder().decode(node.data) : node.data;
  },
  async writeFile(path, data, options) {
    const { dir, name } = lookupParent(path);
    const existing = dir.children.get(name);
    if (existing && existing.kind === "dir") throw fsError("EISDIR", `write '${path}'`);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    const mode = (typeof options === "object" && options?.mode) || 0o644;
    const now = Date.now();
    dir.children.set(name, {
      kind: "file",
      data: bytes,
      mode: mode | 0o100000,
      ino: existing?.ino ?? inoCounter++,
      mtimeMs: now,
      ctimeMs: existing?.ctimeMs ?? now,
    });
  },
  async mkdir(path) {
    const { dir, name } = lookupParent(path);
    if (dir.children.has(name)) throw fsError("EEXIST", `mkdir '${path}'`);
    const now = Date.now();
    dir.children.set(name, { kind: "dir", children: new Map(), ino: inoCounter++, mtimeMs: now, ctimeMs: now });
  },
  async rmdir(path) {
    const { dir, name } = lookupParent(path);
    const node = dir.children.get(name);
    if (!node) throw fsError("ENOENT", `rmdir '${path}'`);
    if (node.kind !== "dir") throw fsError("ENOTDIR", `rmdir '${path}'`);
    if (node.children.size > 0) throw fsError("ENOTEMPTY", `rmdir '${path}'`);
    dir.children.delete(name);
  },
  async unlink(path) {
    const { dir, name } = lookupParent(path);
    const node = dir.children.get(name);
    if (!node) throw fsError("ENOENT", `unlink '${path}'`);
    if (node.kind === "dir") throw fsError("EISDIR", `unlink '${path}'`);
    dir.children.delete(name);
  },
  async readdir(path) {
    const node = lookup(path);
    if (node.kind !== "dir") throw fsError("ENOTDIR", `scandir '${path}'`);
    return [...node.children.keys()];
  },
  async stat(path) {
    let node = lookup(path);
    while (node.kind === "symlink") node = lookup(node.target);
    return statsFor(node);
  },
  async lstat(path) {
    return statsFor(lookup(path));
  },
  async readlink(path) {
    const node = lookup(path);
    if (node.kind !== "symlink") throw fsError("EINVAL", `readlink '${path}'`);
    return node.target;
  },
  async symlink(target, path) {
    const { dir, name } = lookupParent(path);
    if (dir.children.has(name)) throw fsError("EEXIST", `symlink '${path}'`);
    const now = Date.now();
    dir.children.set(name, { kind: "symlink", target, ino: inoCounter++, mtimeMs: now, ctimeMs: now });
  },
  async rm(path, opts) {
    const { dir, name } = lookupParent(path);
    const node = dir.children.get(name);
    if (!node) throw fsError("ENOENT", `rm '${path}'`);
    if (node.kind === "dir" && node.children.size > 0 && !opts?.recursive) {
      throw fsError("ENOTEMPTY", `rm '${path}'`);
    }
    dir.children.delete(name);
  },
};

async function mkdirp(path: string): Promise<void> {
  const segs = parts(path);
  let cur = "";
  for (const seg of segs) {
    cur += `/${seg}`;
    try {
      await testFs.mkdir(cur);
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
    }
  }
}

// Minimal BurrowVfs bridge — only the surface command.ts touches.
const vfsBridge = {
  resolvePath(base: string, path: string): string {
    const raw = path.startsWith("/") ? path : `${base}/${path}`;
    const out: string[] = [];
    for (const seg of raw.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") out.pop();
      else out.push(seg);
    }
    return "/" + out.join("/");
  },
  async exists(path: string): Promise<boolean> {
    try {
      lookup(path);
      return true;
    } catch {
      return false;
    }
  },
  async readFile(path: string): Promise<string> {
    return (await testFs.readFile(path, "utf8")) as string;
  },
  async readdir(path: string): Promise<string[]> {
    return await testFs.readdir(path);
  },
  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    await testFs.writeFile(path, data);
  },
} as unknown as BurrowVfs;

// Stub event bus that records emissions.
const emitted: Array<{ type: string; event: unknown }> = [];
const events: EventBus = {
  on: () => () => {},
  emit<K extends keyof BurrowEventMap>(type: K, event: BurrowEventMap[K]) {
    emitted.push({ type, event });
  },
};

// Dependency-injected API — the module-global registry belongs to
// src/vfs/index.test.ts when the whole suite runs in one process
// (provide() throws on duplicates), so this file must never provide().
const api = createGitApi({ gitFs: testFs, events });

// The registered command spec (grab it through a fresh command instance —
// same code path as the shell's).
import { createGitCommand } from "./command.ts";
const gitCmd = createGitCommand(api);

const REPO = "/home/user/proj";
function ctx(cwd = REPO): CommandContext {
  return { fs: vfsBridge, cwd, env: new Map(), stdin: "" };
}
const run = (line: string, cwd?: string) => gitCmd.execute(line.split(" ").slice(1), ctx(cwd));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ---------------------------------------------------------------------------
// GitAPI + command flow
// ---------------------------------------------------------------------------

test("git init creates a repository", async () => {
  await mkdirp(REPO);
  const r = await gitCmd.execute(["init"], ctx());
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("Initialized empty Git repository");
  expect(await vfsBridge.exists(`${REPO}/.git`)).toBe(true);
});

test("status shows untracked files", async () => {
  await testFs.writeFile(`${REPO}/index.ts`, 'export const hello = "world";\n');
  await mkdirp(`${REPO}/src`);
  await testFs.writeFile(`${REPO}/src/util.ts`, "export const two = 1 + 1;\n");
  const r = await gitCmd.execute(["status"], ctx());
  expect(r.exitCode).toBe(0);
  const plain = strip(r.stdout);
  expect(plain).toContain("On branch main");
  expect(plain).toContain("Untracked files:");
  expect(plain).toContain("index.ts");
  expect(plain).toContain("src/util.ts");
});

test("add . stages everything; status shows new files", async () => {
  const add = await gitCmd.execute(["add", "."], ctx());
  expect(add.exitCode).toBe(0);
  const plain = strip((await gitCmd.execute(["status"], ctx())).stdout);
  expect(plain).toContain("Changes to be committed:");
  expect(plain).toContain("new file");
  expect(plain).not.toContain("Untracked files:");
});

test("commit -m records; log shows it; author defaults to burrow", async () => {
  const r = await gitCmd.execute(["commit", "-m", "initial commit"], ctx());
  expect(r.exitCode).toBe(0);
  const plain = strip(r.stdout);
  expect(plain).toMatch(/^\[main [0-9a-f]{7}\] initial commit/);
  expect(plain).toContain("burrow <burrow@localhost>");

  const log = await gitCmd.execute(["log"], ctx());
  const logPlain = strip(log.stdout);
  expect(logPlain).toMatch(/commit [0-9a-f]{40}/);
  expect(logPlain).toContain("initial commit");
  expect(logPlain).toContain("Author: burrow <burrow@localhost>");

  const entries = await api.log({ dir: REPO });
  expect(entries).toHaveLength(1);
  expect(entries[0]!.parent).toHaveLength(0);
});

test("clean tree: status reports nothing to commit", async () => {
  const plain = strip((await gitCmd.execute(["status"], ctx())).stdout);
  expect(plain).toContain("nothing to commit, working tree clean");
});

test("diff shows HEAD vs workdir; headContent returns HEAD bytes", async () => {
  await testFs.writeFile(`${REPO}/index.ts`, 'export const hello = "burrow";\n');
  const head = await api.headContent("index.ts", REPO);
  expect(head).not.toBeNull();
  expect(new TextDecoder().decode(head!)).toContain('"world"');

  const r = await gitCmd.execute(["diff", "index.ts"], ctx());
  const plain = strip(r.stdout);
  expect(plain).toContain("diff --git a/index.ts b/index.ts");
  expect(plain).toContain('-export const hello = "world";');
  expect(plain).toContain('+export const hello = "burrow";');
  expect(plain).toContain("@@ -1 +1 @@");

  // no-arg diff picks up the same file
  const all = strip((await gitCmd.execute(["diff"], ctx())).stdout);
  expect(all).toContain("diff --git a/index.ts b/index.ts");
});

test("diff works from a subdirectory with relative paths", async () => {
  await testFs.writeFile(`${REPO}/src/util.ts`, "export const two = 2;\n");
  const r = await gitCmd.execute(["diff", "util.ts"], ctx(`${REPO}/src`));
  const plain = strip(r.stdout);
  expect(plain).toContain("diff --git a/src/util.ts b/src/util.ts");
  expect(plain).toContain("+export const two = 2;");
});

test("checkout -- restores HEAD content and emits fs:batch{git}", async () => {
  emitted.length = 0;
  const r = await gitCmd.execute(["checkout", "--", "index.ts", "src/util.ts"], ctx());
  expect(r.exitCode).toBe(0);
  expect(await vfsBridge.readFile(`${REPO}/index.ts`)).toBe('export const hello = "world";\n');
  expect(await vfsBridge.readFile(`${REPO}/src/util.ts`)).toBe("export const two = 1 + 1;\n");
  expect(emitted.some((e) => e.type === "fs:batch" && (e.event as { reason: string }).reason === "git")).toBe(true);

  const plain = strip((await gitCmd.execute(["status"], ctx())).stdout);
  expect(plain).toContain("nothing to commit, working tree clean");
});

test("add -A stages deletions; commit them away", async () => {
  await testFs.unlink(`${REPO}/src/util.ts`);
  let plain = strip((await gitCmd.execute(["status"], ctx())).stdout);
  expect(plain).toContain("deleted");

  await gitCmd.execute(["add", "-A"], ctx());
  plain = strip((await gitCmd.execute(["status"], ctx())).stdout);
  expect(plain).toContain("Changes to be committed:");
  expect(plain).toContain("deleted");

  const r = await gitCmd.execute(["commit", "-m", "remove util"], ctx());
  expect(r.exitCode).toBe(0);
  expect((await api.log({ dir: REPO })).length).toBe(2);
  expect(await api.status("src/util.ts", REPO)).toBe("absent");
});

test("branch prints current branch; api.currentBranch agrees", async () => {
  const r = await gitCmd.execute(["branch"], ctx());
  expect(strip(r.stdout).trim()).toBe("* main");
  expect(await api.currentBranch(REPO)).toBe("main");
});

test("not a repository → exit 128; unknown subcommand → exit 1", async () => {
  await mkdirp("/tmp/elsewhere");
  const r = await gitCmd.execute(["status"], ctx("/tmp/elsewhere"));
  expect(r.exitCode).toBe(128);
  expect(r.stderr).toContain("not a git repository");

  const unknown = await gitCmd.execute(["frobnicate"], ctx());
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain("not a git command");
});

test("setAuthor changes commit identity", async () => {
  api.setAuthor({ name: "Test Author", email: "author@example.com" });
  await testFs.writeFile(`${REPO}/new.txt`, "hi\n");
  await gitCmd.execute(["add", "new.txt"], ctx());
  await gitCmd.execute(["commit", "-m", "by test author"], ctx());
  const [latest] = await api.log({ depth: 1, dir: REPO });
  expect(latest!.author.name).toBe("Test Author");
  api.setAuthor({ name: "burrow", email: "burrow@localhost" });
});

test("commit --message does NOT stage unstaged changes (unlike -am)", async () => {
  await testFs.writeFile(`${REPO}/staged.txt`, "staged\n");
  await testFs.writeFile(`${REPO}/unstaged.txt`, "unstaged\n");
  await gitCmd.execute(["add", "staged.txt"], ctx());

  const r = await gitCmd.execute(["commit", "--message", "staged only"], ctx());
  expect(r.exitCode).toBe(0);

  // unstaged.txt must still be untracked, not swept into the commit.
  const plain = strip((await gitCmd.execute(["status"], ctx())).stdout);
  expect(plain).toContain("Untracked files:");
  expect(plain).toContain("unstaged.txt");
  expect(await api.status("staged.txt", REPO)).toBe("unmodified");

  // -am DOES stage it.
  const r2 = await gitCmd.execute(["commit", "-am", "sweep the rest"], ctx());
  expect(r2.exitCode).toBe(0);
  expect(await api.status("unstaged.txt", REPO)).toBe("unmodified");
});

// ---------------------------------------------------------------------------
// diff.ts units
// ---------------------------------------------------------------------------

test("diffLines: minimal edit script", () => {
  const recs = diffLines(["a", "b", "c"], ["a", "x", "c"]);
  expect(recs).toEqual([
    { tag: " ", line: "a" },
    { tag: "-", line: "b" },
    { tag: "+", line: "x" },
    { tag: " ", line: "c" },
  ]);
});

test("formatUnified: new/deleted files and identical contents", () => {
  expect(formatUnified("same\n", "same\n", "f", { color: false })).toBe("");
  const created = formatUnified(null, "hello\n", "f.txt", { color: false });
  expect(created).toContain("new file mode 100644");
  expect(created).toContain("--- /dev/null");
  expect(created).toContain("+hello");
  const deleted = formatUnified("bye\n", null, "f.txt", { color: false });
  expect(deleted).toContain("deleted file mode 100644");
  expect(deleted).toContain("+++ /dev/null");
  expect(deleted).toContain("-bye");
});

test("formatUnified: hunk headers and no-newline marker", () => {
  const a = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n") + "\n";
  const b = a.replace("line10", "LINE10");
  const out = formatUnified(a, b, "big.txt", { color: false });
  expect(out).toContain("@@ -8,7 +8,7 @@");
  expect(out).toContain("-line10");
  expect(out).toContain("+LINE10");
  expect(out).not.toContain("line0"); // context is 3 — far lines excluded

  const noEol = formatUnified("x\n", "x\ny", "f", { color: false });
  expect(noEol).toContain("\\ No newline at end of file");
});

// ---------------------------------------------------------------------------
// proxy.ts
// ---------------------------------------------------------------------------

test("proxy rejects bad methods and bad paths", async () => {
  const put = await handleGitProxy(new Request("http://localhost/git-proxy/github.com/a/b", { method: "PUT" }));
  expect(put.status).toBe(405);
  const empty = await handleGitProxy(new Request("http://localhost/git-proxy/"));
  expect(empty.status).toBe(400);
  const localhostTarget = await handleGitProxy(new Request("http://localhost/git-proxy/localhost:22/x"));
  expect(localhostTarget.status).toBe(400);
  const wrongPrefix = await handleGitProxy(new Request("http://localhost/other/github.com/a/b"));
  expect(wrongPrefix.status).toBe(400);
});

test("proxy rejects private, link-local, and encoded-IP upstream hosts", async () => {
  const blocked = [
    "127.0.0.1",
    "10.0.0.5",
    "192.168.1.1:8080",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "0.0.0.0",
    "2130706433", // decimal-encoded 127.0.0.1
    "0x7f000001", // hex-encoded 127.0.0.1
    "0177.0.0.1", // octal-encoded 127.0.0.1
    "internal.localhost",
  ];
  for (const host of blocked) {
    const res = await handleGitProxy(new Request(`http://localhost/git-proxy/${host}/a/b`));
    expect(res.status).toBe(400);
  }
  // Public dotted-quads and normal DNS names are not blocked by the host check.
  expect(isBlockedUpstreamHostname("140.82.112.3")).toBe(false);
  expect(isBlockedUpstreamHostname("github.com")).toBe(false);
  expect(isBlockedUpstreamHostname("gitlab.com")).toBe(false);
});

const server = Bun.serve({
  port: 0,
  routes: { "/git-proxy/*": createGitProxyRoute() },
  fetch: () => new Response("not found", { status: 404 }),
});
afterAll(() => server.stop(true));

test(
  "end-to-end: shallow clone through the proxy (network)",
  async () => {
    const proxied = `http://localhost:${server.port}/git-proxy`;

    // Advertisement leg first — proves header/content-type passthrough.
    const infoRefs = await fetch(
      `${proxied}/github.com/octocat/Hello-World/info/refs?service=git-upload-pack`,
    );
    expect(infoRefs.status).toBe(200);
    expect(infoRefs.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(await infoRefs.text()).toContain("git-upload-pack");

    // Full clone via isomorphic-git (absolute corsProxy since Bun's fetch
    // can't resolve the browser-relative "/git-proxy").
    const dir = "/home/user/hello-world";
    await git.clone({
      fs: testFs as unknown as Parameters<typeof git.clone>[0]["fs"],
      http,
      dir,
      url: "https://github.com/octocat/Hello-World",
      corsProxy: proxied,
      singleBranch: true,
      depth: 1,
      noTags: true,
      cache: {},
    });
    expect(await vfsBridge.exists(`${dir}/.git/HEAD`)).toBe(true);
    expect(await vfsBridge.readFile(`${dir}/README`)).toContain("Hello World");

    // And the command layer sees it as a repo.
    const r = await gitCmd.execute(["log", "-n", "1"], ctx(dir));
    expect(r.exitCode).toBe(0);
    expect(strip(r.stdout)).toMatch(/commit [0-9a-f]{40}/);
  },
  30_000,
);
