import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluate,
  mcpServerOf,
  parseRule,
  shellKindOf,
  splitCommands,
  wildcardMatch,
} from "../extensions/allowlist-gate/policy.ts";

const none = { allow: [], deny: [] };

describe("wildcardMatch", () => {
  it("matches trailing star shorthand", () => {
    assert.equal(wildcardMatch("git pull origin main", "git pull *"), true);
    assert.equal(wildcardMatch("git pull", "git pull *"), true);
    assert.equal(wildcardMatch("git push origin", "git pull *"), false);
  });
  it("escapes regex metacharacters and supports ?", () => {
    assert.equal(wildcardMatch("a.b", "a.b"), true);
    assert.equal(wildcardMatch("axb", "a.b"), false);
    assert.equal(wildcardMatch("ab", "a?"), true);
  });
  it("is case-insensitive on Windows only", () => {
    assert.equal(wildcardMatch("GIT status", "git *"), process.platform === "win32");
  });
});

describe("parseRule", () => {
  it("splits scope and pattern, defaults to whole action", () => {
    assert.deepEqual(parseRule("shell:git pull *"), { scope: "shell", pattern: "git pull *" });
    assert.deepEqual(parseRule("bash"), { scope: "bash", pattern: "*" });
    assert.deepEqual(parseRule("edit:"), { scope: "edit", pattern: "*" });
  });
  it("keeps colons inside the pattern and ignores blanks", () => {
    assert.deepEqual(parseRule("shell:docker run -p 80:80 *"), {
      scope: "shell",
      pattern: "docker run -p 80:80 *",
    });
    assert.equal(parseRule("  "), null);
    assert.equal(parseRule(":x"), null);
  });
});

describe("splitCommands", () => {
  it("splits on &&, ||, ;, | and newlines", () => {
    assert.deepEqual(splitCommands("git status && git push origin main"), ["git status", "git push origin main"]);
    assert.deepEqual(splitCommands("ls; pwd"), ["ls", "pwd"]);
    assert.deepEqual(splitCommands("a || b | c"), ["a", "b", "c"]);
    assert.deepEqual(splitCommands("a\nb"), ["a", "b"]);
  });
  it("respects single and double quotes", () => {
    assert.deepEqual(splitCommands(`echo "a && b" && ls`), [`echo "a && b"`, "ls"]);
    assert.deepEqual(splitCommands(`echo 'a; b'`), [`echo 'a; b'`]);
  });
  it("keeps the raw substitution in the outer segment and splits the inner command out", () => {
    assert.deepEqual(splitCommands("echo $(git status)").sort(), ["echo $(git status)", "git status"]);
    assert.deepEqual(splitCommands("echo `git status`").sort(), ["echo `git status`", "git status"]);
  });
  it("splits separators inside substitutions (no smuggling behind an allowed prefix)", () => {
    const segments = splitCommands("echo $(git status; rm -rf x)");
    assert.ok(segments.includes("git status"));
    assert.ok(segments.includes("rm -rf x"));
    assert.ok(splitCommands("echo `git status && rm -rf x`").includes("rm -rf x"));
  });
  it("runs substitutions inside double quotes but not inside single quotes", () => {
    assert.ok(splitCommands('echo "$(rm -rf x)"').includes("rm -rf x"));
    assert.ok(splitCommands('echo "`rm -rf x`"').includes("rm -rf x"));
    assert.deepEqual(splitCommands("echo '$(rm -rf x)'"), ["echo '$(rm -rf x)'"]);
  });
  it("treats a backslash-escaped quote as a literal, not as a quote start", () => {
    const segments = splitCommands('echo \\"hi; rm -rf x; echo \\"');
    assert.ok(segments.includes("rm -rf x"));
  });
  it("splits subshell parentheses", () => {
    assert.deepEqual(splitCommands("(rm -rf x)"), ["rm -rf x"]);
  });
  it("drops empty segments", () => {
    assert.deepEqual(splitCommands("  &&  "), []);
    assert.deepEqual(splitCommands(""), []);
  });
  it("powershell: backslash is not an escape, backtick is", () => {
    const segments = splitCommands('echo "C:\\dir\\"; rm -rf x', "powershell");
    assert.ok(segments.includes("rm -rf x"));
    assert.deepEqual(splitCommands('echo "a`"b; c"', "powershell"), ['echo "a`"b; c"']);
  });
  it("powershell: backtick is not a command substitution", () => {
    assert.deepEqual(splitCommands("echo `;x", "powershell"), ["echo `;x"]);
    assert.ok(splitCommands("echo $(Get-Date; Remove-Item x)", "powershell").includes("Remove-Item x"));
  });
  it("maps tool names to dialects", () => {
    assert.equal(shellKindOf("powershell"), "powershell");
    assert.equal(shellKindOf("bash"), "posix");
  });
});

describe("evaluate: shell with params", () => {
  const lists = { allow: ["shell:git pull *"], deny: [] };
  it("git pull passes", () => {
    assert.equal(evaluate("bash", ["git pull origin main"], lists).decision, "allow");
  });
  it("git push asks", () => {
    assert.equal(evaluate("bash", ["git push origin main"], lists).decision, "ask");
  });
  it("empty resources never auto-allow", () => {
    assert.equal(evaluate("bash", [], lists).decision, "ask");
  });
});

describe("evaluate: shell scope covers bash and powershell", () => {
  const lists = { allow: ["shell:git status *"], deny: [] };
  it("powershell is gated by the same shell rules", () => {
    assert.equal(evaluate("powershell", ["git status"], lists).decision, "allow");
    assert.equal(evaluate("powershell", ["Remove-Item -Recurse *"], lists).decision, "ask");
  });
});

describe("evaluate: compound commands (one resource per sub-command)", () => {
  const lists = { allow: ["shell:git status *", "shell:ls *"], deny: ["shell:rm -rf *"] };
  it("allows only when EVERY sub-command is allowlisted", () => {
    assert.equal(evaluate("bash", splitCommands("git status && ls -la"), lists).decision, "allow");
  });
  it("one allowed part must not let a non-allowed part through", () => {
    assert.equal(
      evaluate("bash", splitCommands("git status && git push origin main"), lists).decision,
      "ask",
    );
  });
  it("ANY denied sub-command blocks the whole command", () => {
    assert.equal(evaluate("bash", splitCommands("ls; rm -rf /tmp/x"), lists).decision, "deny");
  });
});

describe("evaluate: shell redirections always ask", () => {
  const lists = { allow: ["shell:echo *", "shell:cat *", "shell:npm *"], deny: ["shell:rm -rf *"] };
  it("asks for every redirection form even on allowlisted commands", () => {
    for (const command of [
      "echo x > file",
      "echo x >> file",
      "cat a 2> err.log",
      "npm test &> out.log",
      "echo x >| file",
    ]) {
      assert.equal(evaluate("bash", [command], lists).decision, "ask", command);
    }
  });
  it("asks when only one sub-command of a compound command redirects", () => {
    assert.equal(evaluate("bash", splitCommands("echo hi && cat a > b"), lists).decision, "ask");
  });
  it("still allows the same commands without redirection", () => {
    assert.equal(evaluate("bash", ["echo x"], lists).decision, "allow");
  });
  it("cannot be allowlisted away, but the denylist still wins", () => {
    assert.equal(evaluate("bash", ["echo x > file"], { allow: ["shell:*"], deny: [] }).decision, "ask");
    assert.equal(evaluate("bash", ["rm -rf /x > log"], lists).decision, "deny");
  });
});

describe("evaluate: edit scope covers edit and write", () => {
  const lists = { allow: ["edit:docs/*"], deny: ["edit:docs/secret/*"] };
  it("allows matching paths, asks otherwise", () => {
    assert.equal(evaluate("edit", ["docs/readme.md"], lists).decision, "allow");
    assert.equal(evaluate("write", ["docs/readme.md"], lists).decision, "allow");
    assert.equal(evaluate("edit", ["src/index.ts"], lists).decision, "ask");
  });
  it("deny wins inside an allowed folder", () => {
    assert.equal(evaluate("write", ["docs/secret/key.txt"], lists).decision, "deny");
  });
  it("bare `edit` allows every file edit", () => {
    assert.equal(evaluate("edit", ["anything"], { allow: ["edit"], deny: [] }).decision, "allow");
  });
});

describe("evaluate: denylist wins", () => {
  const lists = { allow: ["shell:npm *"], deny: ["shell:npm publish *"] };
  it("npm publish denied even if broadly allowed", () => {
    assert.equal(evaluate("bash", ["npm publish --access public"], lists).decision, "deny");
  });
  it("npm test allowed", () => {
    assert.equal(evaluate("bash", ["npm test"], lists).decision, "allow");
  });
});

describe("evaluate: mcp per-server", () => {
  it("docs server allowed, db server asks", () => {
    const lists = { allow: ["mcp:docs-mcp-server"], deny: [] };
    assert.equal(evaluate("mcp__docs_mcp_server__fetch_url", [], lists).decision, "allow");
    assert.equal(evaluate("mcp__postgres_mcp__query", [], lists).decision, "ask");
  });
  it("denied server blocks", () => {
    const lists = { allow: [], deny: ["mcp:postgres-mcp"] };
    assert.equal(evaluate("mcp__postgres_mcp__query", [], lists).decision, "deny");
  });
  it("matches whole server names only, not loose prefixes", () => {
    const lists = { allow: ["mcp:docs"], deny: [] };
    assert.equal(evaluate("mcp__docs__fetch", [], lists).decision, "allow");
    assert.equal(evaluate("mcp__docs_mcp_server__fetch_url", [], lists).decision, "ask");
  });
  it("supports wildcard server patterns", () => {
    const lists = { allow: ["mcp:docs-*"], deny: [] };
    assert.equal(evaluate("mcp__docs_mcp_server__fetch_url", [], lists).decision, "allow");
    assert.equal(evaluate("mcp__postgres_mcp__query", [], lists).decision, "ask");
  });
  it("normalizes dashes like Pi namespaces do", () => {
    assert.equal(mcpServerOf("mcp__my_server__ping"), "my_server");
    assert.equal(mcpServerOf("mcp__my-server__ping"), "my_server");
    assert.equal(mcpServerOf("read"), null);
  });
});

describe("evaluate: generic fallback for other tools", () => {
  it("whole-action rules cover extension tools", () => {
    assert.equal(evaluate("my-tool", [], { allow: ["my-tool"], deny: [] }).decision, "allow");
    assert.equal(evaluate("my-tool", [], { allow: [], deny: ["my-tool"] }).decision, "deny");
  });
  it("unlisted tools ask", () => {
    assert.equal(evaluate("my-tool", [], none).decision, "ask");
  });
});

describe("evaluate: forceAsk", () => {
  const lists = { allow: ["edit:*"], deny: ["edit:secret/*"] };
  it("asks even when allowlisted", () => {
    assert.equal(evaluate("write", ["x"], lists, { forceAsk: true }).decision, "ask");
  });
  it("deny still wins", () => {
    assert.equal(evaluate("write", ["secret/x"], lists, { forceAsk: true }).decision, "deny");
  });
  it("applies to the calling tool name, not only to the shared edit scope", () => {
    assert.equal(evaluate("write", ["x"], { allow: [], deny: ["write"] }, { forceAsk: true }).decision, "deny");
  });
});

describe("evaluate: safe passthrough and unmapped ask", () => {
  it("read-only tools are never touched", () => {
    for (const tool of [
      "read",
      "grep",
      "find",
      "ls",
      "question",
      "codemode",
      "tool_search",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
    ]) {
      assert.equal(evaluate(tool, ["whatever"], none).decision, "passthrough", tool);
    }
  });
  it("the denylist overrides passthrough", () => {
    assert.equal(evaluate("read", ["secret"], { allow: [], deny: ["read"] }).decision, "deny");
  });
  it("unmapped gated tools ask", () => {
    assert.equal(evaluate("bash", ["git push"], none).decision, "ask");
    assert.equal(evaluate("edit", ["file.txt"], none).decision, "ask");
  });
});
