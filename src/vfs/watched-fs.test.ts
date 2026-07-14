import { describe, expect, test } from "bun:test";
import { Bash, InMemoryFs, type IFileSystem } from "just-bash/browser";
import type { BurrowEventMap, FileChangeKind } from "../contract/types.ts";
import { TypedEventBus } from "./event-bus.ts";
import { WatchedFs } from "./watched-fs.ts";

type Change = BurrowEventMap["file:changed"];

function setup(initial?: ConstructorParameters<typeof InMemoryFs>[0]) {
  const bus = new TypedEventBus();
  const changes: Change[] = [];
  bus.on("file:changed", (e) => changes.push(e));
  const vfs = new WatchedFs(new InMemoryFs(initial), bus);
  return { vfs, bus, changes };
}

function last(changes: Change[]): Change | undefined {
  return changes[changes.length - 1];
}

describe("WatchedFs events", () => {
  test("writeFile emits created for new files, modified for existing", async () => {
    const { vfs, changes } = setup();
    await vfs.writeFile("/a.txt", "one");
    expect(last(changes)).toEqual({ kind: "created", path: "/a.txt" });
    await vfs.writeFile("/a.txt", "two");
    expect(last(changes)).toEqual({ kind: "modified", path: "/a.txt" });
    expect(changes).toHaveLength(2);
  });

  test("appendFile emits created then modified", async () => {
    const { vfs, changes } = setup();
    await vfs.appendFile("/log.txt", "x");
    expect(last(changes)?.kind).toBe("created");
    await vfs.appendFile("/log.txt", "y");
    expect(last(changes)?.kind).toBe("modified");
    expect(await vfs.readFile("/log.txt")).toBe("xy");
  });

  test("emitted paths are normalized", async () => {
    const { vfs, changes } = setup();
    await vfs.writeFile("/home/user/../user/./x.txt", "v");
    expect(last(changes)?.path).toBe("/home/user/x.txt");
  });

  test("mkdir emits created once; recursive re-mkdir of existing emits nothing", async () => {
    const { vfs, changes } = setup();
    await vfs.mkdir("/d");
    expect(last(changes)).toEqual({ kind: "created", path: "/d" });
    await vfs.mkdir("/d", { recursive: true });
    expect(changes).toHaveLength(1);
  });

  test("rm emits a single deleted for the top path, even recursively", async () => {
    const { vfs, changes } = setup({ "/d/a.txt": "a", "/d/sub/b.txt": "b" });
    await vfs.rm("/d", { recursive: true });
    expect(changes).toEqual([{ kind: "deleted", path: "/d" }]);
    expect(await vfs.exists("/d")).toBe(false);
  });

  test("rm with force on a missing path emits nothing", async () => {
    const { vfs, changes } = setup();
    await vfs.rm("/nope", { force: true });
    expect(changes).toHaveLength(0);
  });

  test("cp emits created for the destination", async () => {
    const { vfs, changes } = setup({ "/src.txt": "s" });
    await vfs.cp("/src.txt", "/dest.txt");
    expect(last(changes)).toEqual({ kind: "created", path: "/dest.txt" });
  });

  test("mv emits deleted(src) + created(dest)", async () => {
    const { vfs, changes } = setup({ "/from.txt": "f" });
    await vfs.mv("/from.txt", "/to.txt");
    expect(changes).toEqual([
      { kind: "deleted", path: "/from.txt" },
      { kind: "created", path: "/to.txt" },
    ]);
  });

  test("chmod, symlink, link, utimes emit their kinds", async () => {
    const { vfs, changes } = setup({ "/f.txt": "f" });
    await vfs.chmod("/f.txt", 0o755);
    await vfs.symlink("/f.txt", "/ln");
    await vfs.link("/f.txt", "/hard");
    await vfs.utimes("/f.txt", 1000, 2000);
    expect(changes.map((c) => [c.kind, c.path])).toEqual([
      ["modified", "/f.txt"],
      ["created", "/ln"],
      ["created", "/hard"],
      ["modified", "/f.txt"],
    ] as [FileChangeKind, string][]);
  });

  test("utimes with numbers still leaves stat().mtime a Date", async () => {
    const { vfs } = setup({ "/f.txt": "f" });
    await vfs.utimes("/f.txt", 1234, 5678);
    const stat = await vfs.stat("/f.txt");
    expect(stat.mtime).toBeInstanceOf(Date);
    expect(stat.mtime.getTime()).toBe(5678);
  });

  test("sync mutators emit too", () => {
    const { vfs, changes } = setup();
    vfs.writeFileSync("/s.txt", "1");
    expect(last(changes)).toEqual({ kind: "created", path: "/s.txt" });
    vfs.writeFileSync("/s.txt", "2");
    expect(last(changes)).toEqual({ kind: "modified", path: "/s.txt" });
    vfs.mkdirSync("/sd");
    expect(last(changes)).toEqual({ kind: "created", path: "/sd" });
    expect(changes).toHaveLength(3);
  });

  test("failed mutations emit nothing", async () => {
    const { vfs, changes } = setup({ "/d/child.txt": "c" });
    expect(vfs.mkdir("/d")).rejects.toThrow(); // EEXIST
    expect(vfs.rm("/d")).rejects.toThrow(); // ENOTEMPTY (non-recursive)
    await Promise.allSettled([vfs.mkdir("/d"), vfs.rm("/d")]);
    expect(changes).toHaveLength(0);
  });

  test("reads never emit", async () => {
    const { vfs, changes } = setup({ "/r.txt": "r", "/dir/x.txt": "x" });
    await vfs.readFile("/r.txt");
    await vfs.readFileBuffer("/r.txt");
    await vfs.stat("/r.txt");
    await vfs.lstat("/r.txt");
    await vfs.readdir("/dir");
    await vfs.readdirWithFileTypes("/dir");
    await vfs.exists("/r.txt");
    await vfs.realpath("/r.txt");
    vfs.getAllPaths();
    vfs.resolvePath("/", "a");
    expect(changes).toHaveLength(0);
  });
});

describe("WatchedFs delegation", () => {
  test("is one store: writes are visible through every surface", async () => {
    const { vfs } = setup();
    vfs.writeFileSync("/x.txt", "sync-write");
    expect(await vfs.readFile("/x.txt")).toBe("sync-write");
    expect(vfs.getAllPaths()).toContain("/x.txt");
    const dirents = await vfs.readdirWithFileTypes("/");
    expect(dirents.find((d) => d.name === "x.txt")?.isFile).toBe(true);
  });

  test("readFileBuffer round-trips bytes", async () => {
    const { vfs } = setup();
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await vfs.writeFile("/bin.dat", bytes);
    expect(await vfs.readFileBuffer("/bin.dat")).toEqual(bytes);
  });

  test("symlinks: readlink + realpath + lstat/stat split", async () => {
    const { vfs } = setup({ "/target.txt": "t" });
    await vfs.symlink("/target.txt", "/ln");
    expect(await vfs.readlink("/ln")).toBe("/target.txt");
    expect(await vfs.realpath("/ln")).toBe("/target.txt");
    expect((await vfs.lstat("/ln")).isSymbolicLink).toBe(true);
    expect((await vfs.stat("/ln")).isFile).toBe(true);
  });

  test("works as `new Bash({ fs })`: shell writes hit the store AND emit events", async () => {
    const { vfs, changes } = setup({ "/home/user/data.txt": "alpha\nbeta\n" });
    const bash = new Bash({ fs: vfs as unknown as IFileSystem, cwd: "/home/user" });

    const grep = await bash.exec("grep beta data.txt");
    expect(grep.exitCode).toBe(0);
    expect(grep.stdout).toBe("beta\n");

    const redirect = await bash.exec("echo hello > out.txt && mkdir -p nested/dir");
    expect(redirect.exitCode).toBe(0);
    expect(await vfs.readFile("/home/user/out.txt")).toBe("hello\n");
    expect(changes).toContainEqual({ kind: "created", path: "/home/user/out.txt" });
    expect(changes.some((c) => c.kind === "created" && c.path.startsWith("/home/user/nested"))).toBe(true);

    const rm = await bash.exec("rm out.txt");
    expect(rm.exitCode).toBe(0);
    expect(changes).toContainEqual({ kind: "deleted", path: "/home/user/out.txt" });
  });
});
