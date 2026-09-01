import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setConsoleSubsystemFilter, shouldLogSubsystemToConsole } from "./console.js";
import { createSuiteLogPathTracker } from "./log-test-helpers.js";
import { resetLogger, setLoggerOverride } from "./logger.js";
import { loggingState } from "./state.js";
import { createSubsystemLogger } from "./subsystem.js";

const logPathTracker = createSuiteLogPathTracker("openclaw-subsystem-log-");

function installConsoleMethodSpy(method: "log" | "warn" | "error") {
  const spy = vi.fn();
  loggingState.rawConsole = {
    log: method === "log" ? spy : vi.fn(),
    info: vi.fn(),
    warn: method === "warn" ? spy : vi.fn(),
    error: method === "error" ? spy : vi.fn(),
  };
  return spy;
}

function firstMockArgAsString(mock: { mock: { calls: readonly unknown[][] } }): string {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected console mock call");
  }
  return String(call[0]);
}

beforeAll(async () => {
  await logPathTracker.setup();
});

afterEach(() => {
  setConsoleSubsystemFilter(null);
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

afterAll(async () => {
  await logPathTracker.cleanup();
});

describe("createSubsystemLogger().isEnabled", () => {
  it("returns true for any/file when only file logging would emit", () => {
    setLoggerOverride({ level: "debug", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(false);
  });

  it("returns true for any/console when only console logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "debug" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(true);
    expect(log.isEnabled("debug", "console")).toBe(true);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("uses threshold ordering for non-equal console levels", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "fatal" });
    const fatalOnly = createSubsystemLogger("agent/embedded");

    expect(fatalOnly.isEnabled("error", "console")).toBe(false);
    expect(fatalOnly.isEnabled("fatal", "console")).toBe(true);

    setLoggerOverride({ level: "silent", consoleLevel: "trace" });
    const traceLogger = createSubsystemLogger("agent/embedded");

    expect(traceLogger.isEnabled("debug", "console")).toBe(true);
  });

  it("never treats silent as an emittable console level", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("silent", "console")).toBe(false);
  });

  it("returns false when neither console nor file logging would emit", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "silent" });
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("debug")).toBe(false);
    expect(log.isEnabled("debug", "console")).toBe(false);
    expect(log.isEnabled("debug", "file")).toBe(false);
  });

  it("honors console subsystem filters for console target", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "console")).toBe(false);
  });

  it("does not apply console subsystem filters to file target", () => {
    setLoggerOverride({ level: "info", consoleLevel: "silent" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger("agent/embedded");

    expect(log.isEnabled("info", "file")).toBe(true);
    expect(log.isEnabled("info")).toBe(true);
  });

  it("treats missing subsystem labels as non-matches when filters are active", () => {
    setConsoleSubsystemFilter(["gateway"]);

    expect(shouldLogSubsystemToConsole(undefined as unknown as string)).toBe(false);
  });

  it("disables console logging when a malformed subsystem logger checks enablement", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    setConsoleSubsystemFilter(["gateway"]);
    const log = createSubsystemLogger(undefined as unknown as string);

    expect(log.isEnabled("info", "console")).toBe(false);
  });

  it("falls back to an unknown subsystem label when a malformed logger emits", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger(undefined as unknown as string);

    log.warn("missing subsystem label");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(firstMockArgAsString(warn)).toContain("[unknown]");
  });

  it("suppresses probe warnings for embedded subsystems based on structured run metadata", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded").child("failover");

    log.warn("embedded run failover decision", {
      runId: "probe-test-run",
      consoleMessage: "embedded run failover decision",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not suppress probe errors for embedded subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("agent/embedded").child("failover");

    log.error("embedded run failover decision", {
      runId: "probe-test-run",
      consoleMessage: "embedded run failover decision",
    });

    expect(error).toHaveBeenCalledTimes(1);
  });

  it("suppresses probe warnings for model-fallback child subsystems based on structured run metadata", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.warn("model fallback decision", {
      runId: "probe-test-run",
      consoleMessage: "model fallback decision",
    });

    expect(warn).not.toHaveBeenCalled();
  });

  it("does not suppress probe errors for model-fallback child subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.error("model fallback decision", {
      runId: "probe-test-run",
      consoleMessage: "model fallback decision",
    });

    expect(error).toHaveBeenCalledTimes(1);
  });

  it("still emits non-probe warnings for embedded subsystems", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("agent/embedded").child("auth-profiles");

    log.warn("auth profile failure state updated", {
      runId: "run-123",
      consoleMessage: "auth profile failure state updated",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("still emits non-probe model-fallback child warnings", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("model-fallback").child("decision");

    log.warn("model fallback decision", {
      runId: "run-123",
      consoleMessage: "model fallback decision",
    });

    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("redacts sensitive tokens at the console sink so subsystem writes do not leak secrets (#73284)", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "warn" });
    const warn = installConsoleMethodSpy("warn");
    const log = createSubsystemLogger("gateway");
    const secret = "sk-supersecretvaluefortest12345";

    log.warn(`token=${secret}`);

    expect(warn).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(warn);
    expect(written).not.toContain(secret);
    expect(written).toMatch(/sk-sup…2345|\*\*\*/);
  });

  it("redacts Bearer tokens on subsystem error console writes", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "error" });
    const error = installConsoleMethodSpy("error");
    const log = createSubsystemLogger("gateway").child("auth");
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz";

    log.error(`Authorization failed: ${bearer}`);

    expect(error).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(error);
    expect(written).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(written).toContain("Bearer ");
  });

  it("redacts before colorizing subsystem console messages so ANSI reset codes survive", () => {
    vi.stubEnv("FORCE_COLOR", "1");
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";

    log.info(`provider API_KEY=${secret}`);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(logSpy);
    expect(written).not.toContain(secret);
    expect(written).toContain("API_KEY=***");
    expect(written.endsWith("\u001B[39m")).toBe(true);
  });

  it("redacts sensitive tokens from raw subsystem console output", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info" });
    const logSpy = installConsoleMethodSpy("log");
    const log = createSubsystemLogger("gateway/auth");
    const secret = "sk-rawtokenabcdefghijklmnopqrstuvwxyz123456";

    log.raw(`raw token ${secret}`);

    expect(logSpy).toHaveBeenCalledTimes(1);
    const written = firstMockArgAsString(logSpy);
    expect(written).not.toContain(secret);
    expect(written).toContain("sk-raw…3456");
  });

  it("keeps long-lived subsystem loggers on the current-day rolling file", () => {
    const logDir = path.dirname(logPathTracker.nextPath());
    const firstDay = path.join(logDir, "openclaw-2026-01-01.log");
    const secondDay = path.join(logDir, "openclaw-2026-01-02.log");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T08:00:00Z"));
    setLoggerOverride({ level: "info", consoleLevel: "silent", file: firstDay });
    const log = createSubsystemLogger("diagnostics");

    log.info("first day subsystem log");
    vi.setSystemTime(new Date("2026-01-02T08:00:00Z"));
    log.info("second day subsystem log");

    expect(fs.readFileSync(firstDay, "utf8")).toContain("first day subsystem log");
    expect(fs.readFileSync(secondDay, "utf8")).toContain("second day subsystem log");
    expect(fs.readFileSync(firstDay, "utf8")).not.toContain("second day subsystem log");
  });
});

// ---------------------------------------------------------------------------
// The compact-style meta drop, and the `consoleMessage` escape hatch.
//
// This pair exists because a real instrument was silently useless for months.
// `closed_world.resolved_set` logs the full list of tools the agent was offered
// as STRUCTURED META, and that line was being read in CloudWatch as evidence of
// what the agent could call. It never carried the list: a container has no TTY,
// normalizeConsoleStyle() therefore resolves to "compact", and formatConsoleLine()
// spreads `meta` only in the "json" branch. The line arrived as the bare string.
//
// Both directions are asserted deliberately. The first test PINS the drop, so
// nobody reads a compact line as complete again; the second proves the escape
// hatch actually closes it. A fix asserted only in the passing direction would
// not have caught the original defect.
// ---------------------------------------------------------------------------
describe("compact console style and structured meta", () => {
  it("DROPS structured meta from the compact console line", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    const log = installConsoleMethodSpy("log");
    const logger = createSubsystemLogger("closed-world-gate");

    logger.info("closed_world.resolved_set", {
      mode: "report",
      tool_count: 2,
      tools: ["alpha_tool", "beta_tool"],
    });

    const line = firstMockArgAsString(log);
    expect(line).toContain("closed_world.resolved_set");
    // The defect, pinned: the payload does not reach the console sink.
    expect(line).not.toContain("alpha_tool");
    expect(line).not.toContain("tool_count");
  });

  it("renders `consoleMessage` verbatim so the same detail survives compact style", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "compact" });
    const log = installConsoleMethodSpy("log");
    const logger = createSubsystemLogger("closed-world-gate");

    logger.info("closed_world.resolved_set", {
      mode: "report",
      tool_count: 2,
      tools: ["alpha_tool", "beta_tool"],
      consoleMessage: "closed_world.resolved_set tool_count=2 tools=alpha_tool,beta_tool",
    });

    const line = firstMockArgAsString(log);
    expect(line).toContain("alpha_tool");
    expect(line).toContain("beta_tool");
    expect(line).toContain("tool_count=2");
  });

  it("still spreads the meta itself when the style IS json", () => {
    setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
    const log = installConsoleMethodSpy("log");
    const logger = createSubsystemLogger("closed-world-gate");

    logger.info("closed_world.resolved_set", { tools: ["alpha_tool"] });

    const parsed = JSON.parse(firstMockArgAsString(log)) as { tools?: string[] };
    expect(parsed.tools).toEqual(["alpha_tool"]);
  });
});
