import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { AgentsWindow, isAgentsWindow } from "./agentsWindow";
import { Logger } from "./logger";
import { readCopilotAgentEvents } from "./copilotAgentEvents";
import { RetryEngine } from "./retryEngine";

vi.mock("./copilotAgentEvents", async importOriginal => ({
  ...await importOriginal<typeof import("./copilotAgentEvents")>(),
  readCopilotAgentEvents: vi.fn(),
}));
const resource = "agent-host-copilotcli:/ui-session";
const quota = JSON.stringify({
  type: "session.error", timestamp: "2026-10-23T12:00:00Z", id: "quota",
  data: { errorType: "quota", message: JSON.stringify({
    code: "credit_quota_exhausted", message: "Daily credit limit exceeded. Quata resets in 23h 5m.", retry_after_seconds: 83116,
  }) },
});

describe("Agents window session binding", () => {
  let controller: AgentsWindow;
  let current: string;
  let stored: Map<string, unknown>;
  let execute: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    current = resource;
    stored = new Map();
    const state = {
      get: (key: string) => stored.get(key),
      update: async (key: string, value: unknown) => { stored.set(key, value); },
      keys: () => [...stored.keys()],
    } as unknown as vscode.Memento;
    controller = new AgentsWindow(new Logger(), state);
    vi.spyOn(vscode.commands, "getCommands").mockResolvedValue([
      "sessions.focusActiveSession", "_chat.voice.getCurrentSession", "agentHost.openSessionEventsFile",
    ]);
    vscode.window.activeTextEditor = undefined;
    execute = vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (command: string) => {
      if (command === "_chat.voice.getCurrentSession") { return current as never; }
      if (command === "agentHost.openSessionEventsFile") {
        vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file("/sdk/different-sdk-id/events.jsonl") } };
      }
      return undefined;
    });
    vi.mocked(readCopilotAgentEvents).mockResolvedValue(quota);
  });
  afterEach(() => {
    controller.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("detects the Agents window from its registered commands", async () => {
    expect(await isAgentsWindow()).toBe(true);
    vi.mocked(vscode.commands.getCommands).mockResolvedValue([]);
    expect(await isAgentsWindow()).toBe(false);
  });

  it("binds a UI conversation to the actual SDK file rather than assuming identical IDs", async () => {
    const onError = vi.fn();
    controller.onError(onError);
    await controller.watchCurrentSession();
    expect(onError).toHaveBeenCalledOnce();
    const error = onError.mock.calls[0][0];
    expect(error.sessionId).toBe(resource);
    expect(error.retryAfterSeconds).toBe(83116);
    expect(await controller.canRetry(RetryEngine.triggerFromSessionError(error))).toBe(true);
    expect(controller.getStatus()).toContain("Detected credit_quota_exhausted");
    expect(execute).not.toHaveBeenCalledWith("workbench.panel.chat.view.copilot.focus");
  });

  it("restores a watched binding after reload with the original deadline", async () => {
    await controller.watchCurrentSession();
    controller.stop();
    await vi.advanceTimersByTimeAsync(10000);
    const onError = vi.fn();
    controller.onError(onError);
    await controller.restore();
    const trigger = RetryEngine.triggerFromSessionError(onError.mock.calls[0][0]);
    expect(trigger.retryNotBefore).toBe(Date.parse("2026-10-23T12:00:00Z") + 83_117_000);
  });

  it("fails closed if the active conversation changes or the error clears", async () => {
    await controller.watchCurrentSession();
    const trigger = RetryEngine.triggerFromSessionError((await controller.getCurrentError())!);
    current = "agent-host-copilotcli:/another";
    expect(await controller.canRetry(trigger)).toBe(false);
    current = resource;
    vi.mocked(readCopilotAgentEvents).mockResolvedValue(quota + '\n{"type":"user.message","data":{}}');
    expect(await controller.canRetry(trigger)).toBe(false);
  });

  it("does not bind a stale events editor if the harness command does not open a file", async () => {
    vscode.window.activeTextEditor = { document: { uri: vscode.Uri.file("/unrelated/events.jsonl") } };
    execute.mockImplementation(async () => current as never);
    await expect(controller.watchCurrentSession()).rejects.toThrow("did not reveal");
    expect(stored.size).toBe(0);
  });

  it("explains an unavailable lookup without enabling voice or submitting anything", async () => {
    vi.mocked(vscode.commands.getCommands).mockResolvedValue(["sessions.focusActiveSession"]);
    await expect(controller.watchCurrentSession()).rejects.toThrow("agents.voice.enabled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("deduplicates quota events and emits recovery when the user continues", async () => {
    const onError = vi.fn(), onRecovery = vi.fn();
    controller.onError(onError);
    controller.onRecovery(onRecovery);
    await controller.watchCurrentSession();
    await vi.advanceTimersByTimeAsync(4000);
    expect(onError).toHaveBeenCalledOnce();
    vi.mocked(readCopilotAgentEvents).mockResolvedValue(quota + '\n{"type":"user.message","data":{}}');
    await vi.advanceTimersByTimeAsync(2000);
    expect(onRecovery).toHaveBeenCalledWith(resource);
  });

  it("cancels a pending error when its event file becomes unreadable", async () => {
    const onRecovery = vi.fn();
    controller.onRecovery(onRecovery);
    await controller.watchCurrentSession();
    vi.mocked(readCopilotAgentEvents).mockRejectedValue(new Error("ENOENT"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(onRecovery).toHaveBeenCalledWith(resource);
    expect(controller.getStatus()).toContain("Unable to read");
  });

  it("cancels the old deadline before emitting a replacement quota from the same session", async () => {
    const events: string[] = [];
    controller.onError(() => events.push("quota"));
    controller.onRecovery(() => events.push("cancel"));
    await controller.watchCurrentSession();
    // Both the manual request and its new quota response arrive between polls.
    vi.mocked(readCopilotAgentEvents).mockResolvedValue(quota.replace('"quota"', '"new-quota"'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toEqual(["quota", "cancel", "quota"]);
  });

  it("checks the active conversation after slow event-file I/O", async () => {
    await controller.watchCurrentSession();
    const trigger = RetryEngine.triggerFromSessionError((await controller.getCurrentError())!);
    let finishRead!: (content: string) => void;
    vi.mocked(readCopilotAgentEvents).mockReturnValueOnce(new Promise(resolve => { finishRead = resolve; }));
    const permitted = controller.canRetry(trigger);
    current = "agent-host-copilotcli:/another";
    finishRead(quota);
    expect(await permitted).toBe(false);
  });

  it("does not attach after the watcher is stopped during slow file validation", async () => {
    let finishRead!: (content: string) => void;
    vi.mocked(readCopilotAgentEvents).mockImplementation(() => new Promise(resolve => { finishRead = resolve; }));
    const attaching = controller.watchCurrentSession();
    // Let command resolution reach file validation without advancing poll timers.
    for (let i = 0; i < 10; i++) { await Promise.resolve(); }
    controller.stop();
    finishRead(quota);
    await expect(attaching).rejects.toThrow("canceled or disabled");
    expect(stored.size).toBe(0);
  });
});
