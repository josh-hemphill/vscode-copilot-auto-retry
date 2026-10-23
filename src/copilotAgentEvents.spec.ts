import { describe, expect, it } from "vitest";
import { parseCopilotAgentEvents } from "./copilotAgentEvents";
import { retryAfterDelay } from "./quotaRetry";
import { RetryEngine } from "./retryEngine";

const now = Date.parse("2026-10-23T12:00:00Z");
const providerError = {
  type: "credit_limit_exceeded",
  message: "Daily credit limit exceeded: 5000000/5000000 credits used. Quata resets in 23h 5m. Need a higher limit? Request an increase at https://example.invalid",
  param: null, code: "credit_quota_exhausted", retry_after_seconds: 83116,
};
const event = (data: unknown, extra = {}) => JSON.stringify({
  type: "session.error", id: "error-1", timestamp: new Date(now).toISOString(), data, ...extra,
});

describe("Copilot harness quota errors", () => {
  it.each([
    providerError,
    { error: providerError },
    { errorType: "requestFailed", message: JSON.stringify(providerError) },
    { errorType: "requestFailed", message: `Provider error: ${JSON.stringify({ error: providerError })}` },
  ])("reads the reported provider envelope %#", data => {
    const error = parseCopilotAgentEvents(event(data), now)!;
    expect(error.errorCode).toBe("credit_quota_exhausted");
    expect(error.retryAfterSeconds).toBe(83116);
    const trigger = RetryEngine.triggerFromSessionError({
      ...error, sessionId: "agent-host-copilotcli:/session", hasRetryButton: false,
      target: "agents-window", errorFingerprint: error.fingerprint,
    });
    // Exact structured duration wins over the text rounded to 23h 5m.
    expect(trigger.retryNotBefore).toBe(now + 83_117_000);
    expect(trigger.target).toBe("agents-window");
  });

  it("keeps the original event deadline after reload", () => {
    const error = parseCopilotAgentEvents(event(providerError), now + 10_000)!;
    expect(error.detectedAt).toBe(now);
    expect(error.fingerprint).toBe(parseCopilotAgentEvents(event(providerError), now)!.fingerprint);
  });

  it.each(["user.message", "abort"])("clears a pending quota on %s", type => {
    expect(parseCopilotAgentEvents(event(providerError) + "\n" + JSON.stringify({ type, data: {} }), now)).toBeUndefined();
  });

  it("does not mistake session.idle for quota recovery", () => {
    const result = parseCopilotAgentEvents(event(providerError) + '\n{"type":"session.idle"}', now);
    expect(result?.retryAfterSeconds).toBe(83116);
  });

  it("ignores prompt content, subagent errors and unrelated diagnostics", () => {
    const content = [
      JSON.stringify({ type: "user.message", data: { content: JSON.stringify(providerError) } }),
      event(providerError, { agentId: "subagent" }),
      event({ ...providerError, errorType: "unassociated" }),
    ].join("\n");
    expect(parseCopilotAgentEvents(content, now)).toBeUndefined();
  });

  it("clears a quota superseded by another root error", () => {
    expect(parseCopilotAgentEvents(event(providerError) + "\n" + event({ message: "Canceled", code: "canceled" }), now)).toBeUndefined();
  });

  it("retains a pending quota when an unrelated diagnostic follows it", () => {
    const result = parseCopilotAgentEvents(event(providerError) + "\n" +
      event({ errorType: "unassociated", message: "Unrelated session diagnostic" }), now);
    expect(result?.retryAfterSeconds).toBe(83116);
  });

  it("ignores partial trailing writes without dropping the latest complete quota", () => {
    expect(parseCopilotAgentEvents(event(providerError) + '\n{"type":', now)?.retryAfterSeconds).toBe(83116);
  });

  it.each(["83116", -1, Infinity, NaN, null, 3_000_000])("rejects invalid or overflowing retry seconds %s", seconds => {
    expect(retryAfterDelay(seconds)).toBeUndefined();
  });

  it("accepts zero as a just-reset quota and adds a safety margin", () => {
    expect(retryAfterDelay(0)).toBe(1000);
  });
});
