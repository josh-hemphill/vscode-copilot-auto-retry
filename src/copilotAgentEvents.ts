import { createHash } from "crypto";
import { open } from "fs/promises";
import { isDailyQuotaError, retryAfterDelay } from "./quotaRetry";

export interface CopilotQuotaError {
  errorCode: string;
  message: string;
  retryAfterSeconds?: number;
  detectedAt: number;
  fingerprint: string;
}

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

/** Read only known error-envelope fields; never search prompts or responses. */
function errorEnvelope(value: unknown, depth = 0): JsonObject | undefined {
  if (depth > 4) { return undefined; }
  if (typeof value === "string") {
    const start = value.indexOf("{");
    const end = value.lastIndexOf("}");
    if (start < 0 || end < start) { return undefined; }
    try { return errorEnvelope(JSON.parse(value.slice(start, end + 1)), depth + 1); }
    catch { return undefined; }
  }
  const record = object(value);
  if (!record) { return undefined; }
  const nested = errorEnvelope(record.error, depth + 1) ??
    errorEnvelope(record.message, depth + 1);
  return nested ? { ...record, ...nested } : record;
}

/** Parse the latest root Copilot SDK error, retaining provider reset metadata. */
export function parseCopilotAgentEvents(content: string, now: number): CopilotQuotaError | undefined {
  let latest: CopilotQuotaError | undefined;
  for (const line of content.split("\n")) {
    let event: JsonObject | undefined;
    try { event = object(JSON.parse(line)); } catch { continue; }
    if (!event || event.agentId || object(event.data)?.agentId) { continue; }
    if (event.type === "user.message" || event.type === "abort") {
      latest = undefined;
    } else if (event.type === "session.error") {
      const data = object(event.data);
      if (!data || data.errorType === "unassociated") { continue; }
      // A later request failure supersedes an old quota wait; diagnostics do not.
      latest = undefined;
      const error = errorEnvelope(data);
      if (!error) { continue; }
      const code = typeof error.code === "string" ? error.code :
        typeof error.type === "string" ? error.type :
        typeof error.errorCode === "string" ? error.errorCode : "unknown";
      const message = typeof error.message === "string" ? error.message : "";
      if (!isDailyQuotaError(code, message)) { continue; }
      const eventTime = typeof event.timestamp === "string" ? Date.parse(event.timestamp) : NaN;
      const retryAfterSeconds = retryAfterDelay(error.retry_after_seconds) === undefined
        ? undefined : error.retry_after_seconds as number;
      latest = {
        errorCode: code, message, retryAfterSeconds,
        detectedAt: Number.isFinite(eventTime) && eventTime > 0 && eventTime <= now ? eventTime : now,
        fingerprint: createHash("sha256").update(line).digest("hex"),
      };
    }
  }
  return latest;
}

/** Bound reads of large event logs; discard only a partial first record. */
export async function readCopilotAgentEvents(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    const length = Math.min(stat.size, 524_288);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, stat.size - length);
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return stat.size > length ? content.slice(content.indexOf("\n") + 1) : content;
  } finally { await file.close(); }
}
