import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { RetryEngine, type RetryTrigger } from "./retryEngine";
import { Guardrails } from "./guardrails";
import { Logger } from "./logger";

const trigger = (): RetryTrigger => ({
  source: "session-error", sessionId: "agent-host-copilotcli:/session", target: "agents-window",
  errorCode: "credit_quota_exhausted", errorFingerprint: "quota-event", detail: "Daily quota",
  timestamp: Date.now(), retryNotBefore: Date.now() + 83_117_000,
});

describe("Agents retry routing", () => {
  let engine: RetryEngine;
  let canRetry: ReturnType<typeof vi.fn>;
  let execute: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    const logger = new Logger();
    canRetry = vi.fn().mockResolvedValue(true);
    engine = new RetryEngine(logger, new Guardrails(logger), undefined, { canRetry });
    execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
  });
  afterEach(() => { engine.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

  it("waits the full provider duration and submits in Agents without touching the model or side panel", async () => {
    await engine.triggerRetryCycle(trigger());
    await vi.advanceTimersByTimeAsync(83_116_999);
    expect(execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(401);
    expect(execute.mock.calls.map(call => call[0])).toEqual([
      "sessions.focusActiveSession", "workbench.action.chat.submit",
    ]);
    expect(execute).toHaveBeenLastCalledWith("workbench.action.chat.submit", {
      inputValue: expect.any(String), acceptInputOptions: { preserveInput: true, preserveFocus: true },
    });
    expect(canRetry).toHaveBeenCalledTimes(2);
  });

  it("skips an inactive or superseded target before focusing anything", async () => {
    canRetry.mockResolvedValue(false);
    await engine.triggerRetryCycle(trigger());
    await vi.advanceTimersByTimeAsync(83_118_000);
    expect(execute).not.toHaveBeenCalled();
    expect(engine.getState()).toBe("idle");
  });

  it("rechecks the conversation after the focus settle delay", async () => {
    canRetry.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await engine.triggerRetryCycle(trigger());
    await vi.advanceTimersByTimeAsync(83_118_000);
    expect(execute.mock.calls.map(call => call[0])).toEqual(["sessions.focusActiveSession"]);
    expect(engine.getState()).toBe("idle");
  });

  it("stops without a submission if disabled/canceled during focus settling", async () => {
    await engine.triggerRetryCycle(trigger());
    await vi.advanceTimersByTimeAsync(83_117_001);
    engine.cancelActiveCycle("disabled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(execute.mock.calls.map(call => call[0])).toEqual(["sessions.focusActiveSession"]);
  });

  it("does not run a replacement cycle from a canceled command failure", async () => {
    let rejectFocus!: (reason: unknown) => void;
    execute.mockImplementationOnce(() => new Promise((_, reject) => { rejectFocus = reject; }));
    await engine.triggerRetryCycle(trigger());
    await vi.advanceTimersByTimeAsync(83_117_000);
    engine.cancelActiveCycle("new error");
    await engine.triggerRetryCycle({ ...trigger(), errorFingerprint: "new-error" });
    rejectFocus(new Error("old command failed"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(engine.getCurrentAttempt()).toBe(1);
    expect(engine.getState()).toBe("waiting");
  });
});
