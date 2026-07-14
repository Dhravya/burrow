import { describe, expect, test } from "bun:test";
import { TypedEventBus } from "./event-bus.ts";

describe("TypedEventBus", () => {
  test("delivers events to subscribers in order", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    bus.on("file:changed", (e) => seen.push(`a:${e.kind}:${e.path}`));
    bus.on("file:changed", (e) => seen.push(`b:${e.kind}:${e.path}`));
    bus.emit("file:changed", { kind: "created", path: "/x" });
    expect(seen).toEqual(["a:created:/x", "b:created:/x"]);
  });

  test("on() returns a working unsubscribe", () => {
    const bus = new TypedEventBus();
    let count = 0;
    const off = bus.on("fs:batch", () => count++);
    bus.emit("fs:batch", { reason: "seed" });
    off();
    bus.emit("fs:batch", { reason: "git" });
    expect(count).toBe(1);
  });

  test("does not cross-deliver between event types", () => {
    const bus = new TypedEventBus();
    let cwdEvents = 0;
    bus.on("cwd:changed", () => cwdEvents++);
    bus.emit("fs:batch", { reason: "shell-command" });
    expect(cwdEvents).toBe(0);
  });

  test("a throwing handler is isolated from its siblings", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    const originalError = console.error;
    console.error = () => {};
    try {
      bus.on("editor:open", () => {
        throw new Error("boom");
      });
      bus.on("editor:open", (e) => seen.push(e.path));
      bus.emit("editor:open", { path: "/x.ts" });
    } finally {
      console.error = originalError;
    }
    expect(seen).toEqual(["/x.ts"]);
  });

  test("unsubscribing during dispatch does not skip other handlers", () => {
    const bus = new TypedEventBus();
    const seen: string[] = [];
    const off = bus.on("run:started", () => {
      seen.push("first");
      off();
    });
    bus.on("run:started", () => seen.push("second"));
    bus.emit("run:started", { sessionId: "s", entryPath: "/e.ts" });
    expect(seen).toEqual(["first", "second"]);
  });
});
