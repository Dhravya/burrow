import { describe, expect, test } from "bun:test";
import { basename, dirname, isInside, joinPath, normalizePath } from "./paths.ts";

describe("normalizePath", () => {
  test("collapses dots, double slashes, and parent hops", () => {
    expect(normalizePath("/home/user/../user/./x//y.txt")).toBe("/home/user/x/y.txt");
    expect(normalizePath("/a/b/c/../../d")).toBe("/a/d");
    expect(normalizePath("//")).toBe("/");
    expect(normalizePath("/..")).toBe("/");
  });

  test("keeps relative paths relative", () => {
    expect(normalizePath("a/./b/../c")).toBe("a/c");
    expect(normalizePath("../x")).toBe("../x");
    expect(normalizePath("a/..")).toBe(".");
  });
});

describe("dirname / basename", () => {
  test("root and single-segment", () => {
    expect(dirname("/")).toBe("/");
    expect(dirname("/a")).toBe("/");
    expect(basename("/")).toBe("/");
    expect(basename("/a")).toBe("a");
  });

  test("nested", () => {
    expect(dirname("/home/user/x.txt")).toBe("/home/user");
    expect(basename("/home/user/x.txt")).toBe("x.txt");
    expect(dirname("/home/user/dir/")).toBe("/home/user");
  });
});

describe("joinPath", () => {
  test("joins and normalizes", () => {
    expect(joinPath("/home/user", "demo", "index.ts")).toBe("/home/user/demo/index.ts");
    expect(joinPath("/home/user", "../root")).toBe("/home/root");
    expect(joinPath()).toBe(".");
  });
});

describe("isInside", () => {
  test("prefix semantics on segment boundaries", () => {
    expect(isInside("/home/user", "/home/user/x")).toBe(true);
    expect(isInside("/home/user", "/home/user")).toBe(true);
    expect(isInside("/home/user", "/home/username")).toBe(false);
    expect(isInside("/", "/anything")).toBe(true);
  });
});
