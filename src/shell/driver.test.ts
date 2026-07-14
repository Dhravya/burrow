/**
 * Burrow — src/shell/driver.test.ts
 * Definition of done (CONTRACT.md §10, shell): cd/export persist, Ctrl+C
 * aborts a running sleep, `edit x.ts` raises editor:open.
 */

import { expect, test } from "bun:test";
import { Bash, defineCommand, InMemoryFs } from "just-bash/browser";
import type { CustomCommand, ExecResult } from "just-bash/browser";
import { provide, tryUse } from "../contract/registry.ts";
import type { BurrowEventMap, CommandContext, EventBus } from "../contract/types.ts";
import { editorOpenCommand } from "./commands.ts";
import { BASE_ENV, ShellDriver } from "./driver.ts";

function createBus(): EventBus {
  const handlers = new Map<string, Set<(event: never) => void>>();
  return {
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler as (event: never) => void);
      return () => set!.delete(handler as (event: never) => void);
    },
    emit(type, event) {
      handlers.get(type)?.forEach((handler) => {
        try {
          (handler as (e: unknown) => void)(event);
        } catch (err) {
          console.error(err);
        }
      });
    },
  };
}

/** commands.ts resolves "events" through the registry — provide once, lazily. */
function registryBus(): EventBus {
  const existing = tryUse("events");
  if (existing) return existing;
  const bus = createBus();
  provide("events", bus);
  return bus;
}

function makeDriver(customCommands: CustomCommand[] = []) {
  const fs = new InMemoryFs({ "/home/user/README.md": "hello burrow\n" });
  const bash = new Bash({
    fs,
    customCommands,
    env: { ...BASE_ENV },
    cwd: "/home/user",
  });
  const bus = createBus();
  const emitted: Array<{ type: keyof BurrowEventMap; event: unknown }> = [];
  bus.on("cwd:changed", (e) => emitted.push({ type: "cwd:changed", event: e }));
  bus.on("fs:batch", (e) => emitted.push({ type: "fs:batch", event: e }));
  let out = "";
  const driver = new ShellDriver({
    bash,
    events: bus,
    write: (data) => {
      out += data;
    },
  });
  return { driver, emitted, output: () => out, reset: () => (out = "") };
}

test("cd persists across execs and emits cwd:changed", async () => {
  const { driver, emitted } = makeDriver();
  await driver.exec("mkdir -p proj/src");
  await driver.exec("cd proj/src");
  expect(driver.getCwd()).toBe("/home/user/proj/src");
  expect(emitted).toContainEqual({ type: "cwd:changed", event: { cwd: "/home/user/proj/src" } });
  const pwd = await driver.exec("pwd");
  expect(pwd.stdout.trim()).toBe("/home/user/proj/src");
});

test("export persists across execs", async () => {
  const { driver } = makeDriver();
  await driver.exec("export FOO=bar");
  const result = await driver.exec("echo $FOO");
  expect(result.stdout).toBe("bar\n");
});

test("fs:batch{shell-command} is emitted after every command", async () => {
  const { driver, emitted } = makeDriver();
  await driver.exec("true");
  await driver.exec("definitely-not-a-command || true");
  const batches = emitted.filter((e) => e.type === "fs:batch");
  expect(batches.length).toBe(2);
  expect(batches[0]!.event).toEqual({ reason: "shell-command" });
});

test("typed input executes; stdout uses \\r\\n and stderr renders red", async () => {
  const { driver, output } = makeDriver();
  driver.start();
  await driver.handleInput("echo hi && cat missing.txt");
  await driver.handleInput("\r");
  expect(output()).toContain("hi\r\n");
  expect(output()).toContain("\x1b[31m");
  // prompt is re-rendered after the command
  expect(output()).toContain("user@burrow");
});

test("Ctrl+C aborts a running sleep (exitCode 126, shell stays usable)", async () => {
  const { driver, output } = makeDriver();
  driver.start();
  const started = Date.now();
  const done = driver.handleInput("sleep 999\r");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await driver.handleInput("\x03"); // busy → interrupt, not line editing
  await done;
  expect(Date.now() - started).toBeLessThan(4000);
  expect(output()).toContain("^C");
  // shell is alive afterwards
  const after = await driver.exec("echo alive");
  expect(after.stdout).toBe("alive\n");
});

test("up-arrow recalls history", async () => {
  const { driver, output, reset } = makeDriver();
  driver.start();
  await driver.handleInput("echo one\r");
  reset();
  await driver.handleInput("\x1b[A");
  expect(output()).toContain("echo one");
});

test("async tab completion does not interleave with a following keystroke", async () => {
  // fs seeds /home/user/README.md — `RE`+Tab completes to `README.md`.
  const { driver, output, reset } = makeDriver();
  driver.start();
  await driver.handleInput("cat RE");
  reset();

  // Fire Tab (async: awaits a VFS probe) and a printable key WITHOUT awaiting
  // between them, exactly as WTerm's onData delivers rapid keystrokes. The `!`
  // must land AFTER the completion, not race ahead of it.
  const tab = driver.handleInput("\t");
  const bang = driver.handleInput("!");
  await Promise.all([tab, bang]);

  const out = output();
  expect(out.indexOf("ADME.md")).toBeGreaterThanOrEqual(0); // completion happened
  expect(out.indexOf("!")).toBeGreaterThan(out.indexOf("ADME.md")); // and came first
});

test("echo exec renders the command like a typed line", async () => {
  const { driver, output } = makeDriver();
  driver.start();
  const result = await driver.exec("echo from-run-button", { echo: true });
  expect(result.exitCode).toBe(0);
  expect(output()).toContain("echo from-run-button");
  expect(output()).toContain("from-run-button\r\n");
});

test("edit emits editor:open with the resolved path", async () => {
  const bus = registryBus();
  const opened: Array<{ path: string; line?: number; column?: number }> = [];
  const unsubscribe = bus.on("editor:open", (e) => opened.push(e));
  const spec = editorOpenCommand("edit");
  const command = defineCommand(spec.name, (args, ctx): Promise<ExecResult> =>
    spec.execute(args, ctx as unknown as CommandContext),
  );
  const { driver } = makeDriver([command]);
  await driver.exec("mkdir -p src && touch src/x.ts");
  await driver.exec("cd src");
  const result = await driver.exec("edit x.ts");
  expect(result.exitCode).toBe(0);
  expect(opened).toContainEqual({ path: "/home/user/src/x.ts" });
  // path:line spec
  await driver.exec("edit x.ts:12:3");
  expect(opened).toContainEqual({ path: "/home/user/src/x.ts", line: 12, column: 3 });
  // usage error
  const usage = await driver.exec("edit");
  expect(usage.exitCode).toBe(1);
  unsubscribe();
});
