import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { classifyPath, resolveToolPath } from "../extensions/allowlist-gate/paths.ts";

const cwd = resolve(tmpdir(), "allowlist-paths-project");

describe("classifyPath: inside the project", () => {
  it("returns a project-relative, slash-separated resource", () => {
    assert.deepEqual(classifyPath("docs/readme.md", cwd), { resource: "docs/readme.md", outside: false });
    assert.deepEqual(classifyPath("./docs/../src/a.ts", cwd), { resource: "src/a.ts", outside: false });
  });
  it("relativizes absolute paths inside the project, so relative rules still match", () => {
    assert.deepEqual(classifyPath(join(cwd, "src", "a.ts"), cwd), { resource: "src/a.ts", outside: false });
  });
  it("strips Pi's leading @ like the host does", () => {
    assert.deepEqual(classifyPath("@docs/a.md", cwd), { resource: "docs/a.md", outside: false });
  });
  it("names the project directory itself '.'", () => {
    assert.deepEqual(classifyPath(".", cwd), { resource: ".", outside: false });
  });
  it("does not mistake names starting with '..' for parent traversal", () => {
    assert.equal(classifyPath("..hidden/file", cwd).outside, false);
  });
});

describe("classifyPath: outside the project", () => {
  it("flags parent traversal", () => {
    assert.equal(classifyPath("../other/file", cwd).outside, true);
    assert.equal(classifyPath("..", cwd).outside, true);
    assert.equal(classifyPath("src/../../x", cwd).outside, true);
  });
  it("flags absolute paths elsewhere, reported as absolute slash paths", () => {
    const target = resolve(tmpdir(), "elsewhere", "f.txt");
    const result = classifyPath(target, cwd);
    assert.equal(result.outside, true);
    assert.equal(result.resource, target.replaceAll("\\", "/"));
  });
  it("expands ~ to the home directory instead of treating it as a project folder", () => {
    assert.equal(classifyPath("~/.bashrc", cwd).outside, true);
    assert.equal(resolveToolPath("~", cwd), homedir());
    assert.equal(resolveToolPath("~/x", cwd), join(homedir(), "x"));
  });
  it("sees through @ + ~ combinations", () => {
    assert.equal(classifyPath("@~/.bashrc", cwd).outside, true);
  });
});
