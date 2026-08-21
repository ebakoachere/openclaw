import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { wrapToolMemoryFlushAppendOnlyWrite } from "./agent-tools.read.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

// The memory-flush write wrapper used to REJECT any `path` argument that did
// not resolve to the exact file the server had picked. On 2026-08-21 at
// 07:11:16Z that rejection took Agent Alpha's flush out entirely:
//
//   [tools] write failed: Memory flush writes are restricted to
//   memory/2026-08-21.md; use that path only.
//   raw_params={"content":"\n## Heartbeat Status Check (2026-08-20 ~23:12 UTC)...
//
// The server derives TODAY's UTC date; the model named the date of the CONTENT
// it was summarising, which after midnight is YESTERDAY. One tool call, one
// throw, and the whole session's durable memory was lost.
//
// The check protected nothing. The wrapper appends to a path built from its
// OPTIONS -- the model's argument is never forwarded to the writer -- so the
// tool could not write elsewhere even if it accepted the call. These tests pin
// both halves: the call now succeeds, and the bytes still land in exactly one
// file. Every containment assertion is made against the FILESYSTEM, because a
// return value that says "appended to X" is exactly what a broken redirect
// would also say.
describe("memory flush write wrapper: path argument", () => {
  const TODAY_RELATIVE = "memory/2026-08-21.md";

  async function withHarness(
    run: (harness: {
      workspaceDir: string;
      outsideDir: string;
      allowedFile: string;
      wrapped: AnyAgentTool;
      baseWrite: ReturnType<typeof vi.fn>;
    }) => Promise<void>,
  ) {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-flush-path-"));
    const workspaceDir = path.join(tmpDir, "workspace");
    const outsideDir = path.join(tmpDir, "outside");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    const allowedFile = path.join(workspaceDir, TODAY_RELATIVE);
    await fs.mkdir(path.dirname(allowedFile), { recursive: true });
    await fs.writeFile(allowedFile, "seed", "utf-8");

    // The base tool THROWS. If the wrapper ever delegated -- which is the only
    // way a params-derived path could reach a real writer -- the test fails
    // loudly instead of quietly writing somewhere unexpected.
    const baseWrite = vi.fn(async () => {
      throw new Error("the append-only wrapper must never delegate to the base write tool");
    });
    const writeTool: AnyAgentTool = {
      name: "write",
      label: "write",
      description: "Write content to a file.",
      parameters: { type: "object", properties: {} },
      execute: baseWrite,
    };
    const wrapped = wrapToolMemoryFlushAppendOnlyWrite(writeTool, {
      root: workspaceDir,
      relativePath: TODAY_RELATIVE,
    });

    try {
      await run({ workspaceDir, outsideDir, allowedFile, wrapped, baseWrite });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }

  // Proves the assertion "this file does not exist" is meaningful: the same
  // process CAN create it, so its absence is the tool declining, not the
  // filesystem refusing.
  async function assertWritableThenAbsent(target: string) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "positive-control", "utf-8");
    await expect(fs.readFile(target, "utf-8")).resolves.toBe("positive-control");
    await fs.rm(target, { force: true });
    await expect(fs.stat(target)).rejects.toThrow();
  }

  it("accepts YESTERDAY's date -- the exact call that killed the 07:11:16Z flush", async () => {
    await withHarness(async ({ workspaceDir, allowedFile, wrapped, baseWrite }) => {
      const yesterdayRelative = "memory/2026-08-20.md";
      const yesterdayAbsolute = path.join(workspaceDir, yesterdayRelative);
      await assertWritableThenAbsent(yesterdayAbsolute);

      const result = await wrapped.execute("flush-yesterday", {
        path: yesterdayRelative,
        content: "\n## Heartbeat Status Check (2026-08-20 ~23:12 UTC)",
      });

      // It no longer throws...
      expect(baseWrite).not.toHaveBeenCalled();
      // ...the content is in TODAY's file...
      await expect(fs.readFile(allowedFile, "utf-8")).resolves.toBe(
        "seed\n## Heartbeat Status Check (2026-08-20 ~23:12 UTC)",
      );
      // ...yesterday's file was never created...
      await expect(fs.stat(yesterdayAbsolute)).rejects.toThrow();
      // ...and the model is TOLD where the bytes actually went, naming both the
      // real destination and the path it asked for. Without this the model
      // believes it wrote memory/2026-08-20.md and may "correct" itself by
      // writing the same content again.
      const text = result.content[0]?.text ?? "";
      expect(text).toContain(TODAY_RELATIVE);
      expect(text).toContain(yesterdayRelative);
      expect(result.details).toMatchObject({
        path: TODAY_RELATIVE,
        appendOnly: true,
        redirected: true,
        requestedPath: yesterdayRelative,
      });
    });
  });

  it("an ABSOLUTE path outside the workspace lands in the allowed file and nowhere else", async () => {
    await withHarness(async ({ outsideDir, allowedFile, wrapped, baseWrite }) => {
      const absoluteTarget = path.join(outsideDir, "stolen.md");
      await assertWritableThenAbsent(absoluteTarget);

      await wrapped.execute("flush-absolute", {
        path: absoluteTarget,
        content: "absolute attempt",
      });

      expect(baseWrite).not.toHaveBeenCalled();
      await expect(fs.stat(absoluteTarget)).rejects.toThrow();
      await expect(fs.readFile(allowedFile, "utf-8")).resolves.toBe("seed\nabsolute attempt");
      // Nothing at all was created outside the workspace.
      await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
    });
  });

  it("a ../ escape lands in the allowed file and nowhere else", async () => {
    await withHarness(async ({ outsideDir, allowedFile, wrapped, baseWrite }) => {
      // Relative to the workspace root, this resolves into the sibling dir.
      const escapeRelative = path.join("..", "outside", "escaped.md");
      const escapeTarget = path.join(outsideDir, "escaped.md");
      await assertWritableThenAbsent(escapeTarget);

      await wrapped.execute("flush-dotdot", {
        path: escapeRelative,
        content: "escape attempt",
      });

      expect(baseWrite).not.toHaveBeenCalled();
      await expect(fs.stat(escapeTarget)).rejects.toThrow();
      await expect(fs.readFile(allowedFile, "utf-8")).resolves.toBe("seed\nescape attempt");
      await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
    });
  });

  it("repeated wrong-path calls APPEND -- they never truncate the allowed file", async () => {
    await withHarness(async ({ allowedFile, wrapped }) => {
      await wrapped.execute("flush-1", { path: "memory/2026-08-19.md", content: "one" });
      await wrapped.execute("flush-2", { path: "/tmp/anywhere.md", content: "two" });
      await wrapped.execute("flush-3", { path: TODAY_RELATIVE, content: "three" });
      await expect(fs.readFile(allowedFile, "utf-8")).resolves.toBe("seed\none\ntwo\nthree");
    });
  });

  it("the happy path is unchanged: no redirect fields, and the plain message", async () => {
    await withHarness(async ({ allowedFile, wrapped }) => {
      const result = await wrapped.execute("flush-today", {
        path: TODAY_RELATIVE,
        content: "durable note",
      });
      expect(result.content).toEqual([
        { type: "text", text: `Appended content to ${TODAY_RELATIVE}.` },
      ]);
      expect(result.details).toEqual({ path: TODAY_RELATIVE, appendOnly: true });
      await expect(fs.readFile(allowedFile, "utf-8")).resolves.toBe("seed\ndurable note");
    });
  });
});
