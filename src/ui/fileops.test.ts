import { describe, expect, test } from "bun:test";
import { childNames, countDescendants, remapPath, stemRange, validateName } from "./fileops.ts";

describe("validateName", () => {
  const siblings = ["index.ts", "src", "README.md"];

  test("accepts a fresh, plain name", () => {
    expect(validateName("server.ts", { siblings })).toBeNull();
    expect(validateName("no-extension", { siblings })).toBeNull();
    expect(validateName(".env", { siblings })).toBeNull();
  });

  test("rejects the empty name", () => {
    expect(validateName("", { siblings })).toBe("name required");
  });

  test("rejects names with slashes", () => {
    expect(validateName("a/b", { siblings })).toContain("slashes");
    expect(validateName("a\\b", { siblings })).toContain("slashes");
    expect(validateName("/lead", { siblings })).toContain("slashes");
  });

  test("rejects duplicates against siblings (files and dirs)", () => {
    expect(validateName("index.ts", { siblings })).toContain("already exists");
    expect(validateName("src", { siblings })).toContain("already exists");
  });

  test("duplicate check is exact, not case-folded", () => {
    expect(validateName("INDEX.TS", { siblings })).toBeNull();
  });

  test("rename may keep its own current name", () => {
    expect(validateName("index.ts", { siblings, current: "index.ts" })).toBeNull();
  });

  test("rename still collides with OTHER siblings", () => {
    expect(validateName("src", { siblings, current: "index.ts" })).toContain("already exists");
  });

  test("rejects reserved dot names", () => {
    expect(validateName(".", { siblings })).toBe("reserved name");
    expect(validateName("..", { siblings })).toBe("reserved name");
  });

  test("rejects surrounding whitespace", () => {
    expect(validateName(" x", { siblings })).toContain("whitespace");
    expect(validateName("x ", { siblings })).toContain("whitespace");
    expect(validateName("a b", { siblings })).toBeNull(); // inner spaces are fine
  });

  test("rejects control characters", () => {
    expect(validateName("a\nb", { siblings })).toContain("control");
    expect(validateName("a\tb", { siblings })).toContain("control");
  });
});

describe("childNames", () => {
  const paths = [
    "/",
    "/home",
    "/home/user",
    "/home/user/README.md",
    "/home/user/demo",
    "/home/user/demo/index.ts",
    "/home/user/demo/sub",
    "/home/user/demo/sub/deep.ts",
    "/home/user/emptydir",
  ];

  test("lists immediate children only", () => {
    expect(childNames(paths, "/home/user").sort()).toEqual(["README.md", "demo", "emptydir"]);
  });

  test("nested dir", () => {
    expect(childNames(paths, "/home/user/demo").sort()).toEqual(["index.ts", "sub"]);
  });

  test("empty dir has no children", () => {
    expect(childNames(paths, "/home/user/emptydir")).toEqual([]);
  });

  test("tolerates a trailing slash on dir", () => {
    expect(childNames(paths, "/home/user/demo/").sort()).toEqual(["index.ts", "sub"]);
  });
});

describe("countDescendants", () => {
  const paths = ["/home/user", "/home/user/a", "/home/user/a/x.ts", "/home/user/a/sub", "/home/user/a/sub/y.ts"];

  test("counts everything under the dir recursively", () => {
    expect(countDescendants(paths, "/home/user/a")).toBe(3);
  });

  test("zero for an empty dir", () => {
    expect(countDescendants(paths, "/home/user/a/sub/y.ts")).toBe(0);
  });
});

describe("remapPath", () => {
  test("exact match maps to the destination", () => {
    expect(remapPath("/a/b", "/a/b", "/a/c")).toBe("/a/c");
  });

  test("descendants get the prefix swapped", () => {
    expect(remapPath("/a/b/x/y.ts", "/a/b", "/a/c")).toBe("/a/c/x/y.ts");
  });

  test("unrelated paths return null", () => {
    expect(remapPath("/a/bb/x.ts", "/a/b", "/a/c")).toBeNull();
    expect(remapPath("/other", "/a/b", "/a/c")).toBeNull();
  });
});

describe("stemRange", () => {
  test("selects the name without its extension", () => {
    expect(stemRange("index.ts")).toEqual({ start: 0, end: 5 });
  });

  test("dotfiles and extensionless names select everything", () => {
    expect(stemRange(".env")).toEqual({ start: 0, end: 4 });
    expect(stemRange("Makefile")).toEqual({ start: 0, end: 8 });
  });
});
