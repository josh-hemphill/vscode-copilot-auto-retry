import * as vscode from "vscode";
import { basename } from "path";
import { Logger } from "./logger";
import { readConfig } from "./configuration";
import { parseCopilotAgentEvents, readCopilotAgentEvents } from "./copilotAgentEvents";
import type { SessionError } from "./sessionWatcher";
import type { RetryTrigger } from "./retryEngine";

const BINDING_KEY = "agentsWindow.watchedCopilotSession";
const CURRENT_SESSION_COMMAND = "_chat.voice.getCurrentSession";
interface Binding { sessionResource: string; eventsPath: string; }

export async function isAgentsWindow(): Promise<boolean> {
  return (await vscode.commands.getCommands(true)).includes("sessions.focusActiveSession");
}

function isCopilotSession(resource: unknown): resource is string {
  return typeof resource === "string" && /^(?:agent-host-copilotcli|copilotcli):/.test(resource);
}

/** Watches one explicitly selected local harness session, never other windows' logs. */
export class AgentsWindow implements vscode.Disposable {
  private binding: Binding | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private fingerprint: string | undefined;
  private status = "Not watching — run Watch Current Agents Session";
  private readonly errorListeners: Array<(error: SessionError) => void> = [];
  private readonly recoveryListeners: Array<(session: string) => void> = [];

  constructor(private readonly logger: Logger, private readonly workspaceState: vscode.Memento) {}

  onError(listener: (error: SessionError) => void): void { this.errorListeners.push(listener); }
  onRecovery(listener: (session: string) => void): void { this.recoveryListeners.push(listener); }
  getStatus(): string { return this.status; }

  private async currentSession(): Promise<string | undefined> {
    // Read-only lookup: this does not start voice, access a microphone, or send input.
    const commands = await vscode.commands.getCommands(false);
    if (!commands.includes(CURRENT_SESSION_COMMAND)) {
      throw new Error("Agents current-session lookup is unavailable. Enable agents.voice.enabled and reload the Agents window. No voice session or microphone is started by this extension.");
    }
    const resource = await vscode.commands.executeCommand<unknown>(CURRENT_SESSION_COMMAND);
    return isCopilotSession(resource) ? resource : undefined;
  }

  async watchCurrentSession(): Promise<void> {
    const generation = this.generation;
    const sessionResource = await this.currentSession();
    if (!sessionResource) { throw new Error("Select an existing local Copilot harness conversation first."); }
    // The harness owns the SDK file mapping, which may differ from the UI session UUID.
    // Its developer command resolves that mapping without guessing a home directory.
    const previousEditor = vscode.window.activeTextEditor;
    await vscode.commands.executeCommand("agentHost.openSessionEventsFile");
    if (vscode.window.activeTextEditor === previousEditor ||
      (previousEditor && vscode.window.activeTextEditor?.document.uri.toString() === previousEditor.document.uri.toString())) {
      throw new Error("The harness did not reveal a new state-file editor. Close any open events.jsonl tab and try Watch Current Agents Session again.");
    }
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== "file" || basename(uri.fsPath) !== "events.jsonl") {
      throw new Error("The active Copilot session did not expose a local events.jsonl file. Remote and cloud harness sessions are not supported.");
    }
    if (await this.currentSession() !== sessionResource) {
      throw new Error("The active Agents conversation changed while attaching. Select it and try again.");
    }
    const binding = { sessionResource, eventsPath: uri.fsPath };
    // Validate the file before replacing a working watch.
    await readCopilotAgentEvents(binding.eventsPath);
    if (generation !== this.generation || !readConfig().enabled) {
      throw new Error("Watching was canceled or disabled while attaching. Enable the extension and try again.");
    }
    this.stop();
    this.binding = binding;
    await this.workspaceState.update(BINDING_KEY, binding);
    if (this.binding !== binding || !readConfig().enabled) { return; }
    this.status = `Watching Copilot Agents session ${sessionResource}`;
    this.logger.info(this.status);
    await this.poll(this.generation);
  }

  async restore(): Promise<void> {
    this.stop();
    const binding = this.workspaceState.get<Binding>(BINDING_KEY);
    if (!binding || !isCopilotSession(binding.sessionResource) ||
      typeof binding.eventsPath !== "string" || basename(binding.eventsPath) !== "events.jsonl") { return; }
    this.binding = binding;
    this.status = `Watching Copilot Agents session ${binding.sessionResource}`;
    await this.poll(this.generation);
  }

  async getCurrentError(): Promise<SessionError | undefined> {
    const binding = this.binding;
    if (!binding) { return undefined; }
    const error = parseCopilotAgentEvents(await readCopilotAgentEvents(binding.eventsPath), Date.now());
    if (!error) { return undefined; }
    return {
      sessionId: binding.sessionResource, errorCode: error.errorCode,
      message: error.message, hasRetryButton: false, detectedAt: error.detectedAt,
      retryAfterSeconds: error.retryAfterSeconds, target: "agents-window",
      errorFingerprint: error.fingerprint,
    };
  }

  private async poll(generation: number): Promise<void> {
    try {
      const error = await this.getCurrentError();
      if (generation !== this.generation || !readConfig().enabled) { return; }
      if (error && error.errorFingerprint !== this.fingerprint) {
        if (this.fingerprint && this.binding) {
          for (const listener of this.recoveryListeners) { listener(this.binding.sessionResource); }
        }
        this.fingerprint = error.errorFingerprint;
        this.status = `Detected ${error.errorCode}`;
        this.logger.info(`Copilot Agents quota detected: code=${error.errorCode}, retry_after_seconds=${error.retryAfterSeconds ?? "unavailable"}`);
        for (const listener of this.errorListeners) { listener(error); }
      } else if (!error && this.fingerprint) {
        this.fingerprint = undefined;
        this.status = "Watching — previous quota error was superseded or canceled";
        if (this.binding) { for (const listener of this.recoveryListeners) { listener(this.binding.sessionResource); } }
      }
    } catch {
      // Do not print provider error bodies, URL parameters, prompts, or tokens.
      if (generation !== this.generation) { return; }
      if (this.fingerprint && this.binding) {
        this.fingerprint = undefined;
        for (const listener of this.recoveryListeners) { listener(this.binding.sessionResource); }
      }
      const status = "Unable to read watched Copilot events; automatic retry will be skipped";
      if (this.status !== status) { this.logger.warn(status); }
      this.status = status;
    } finally {
      if (generation === this.generation && readConfig().enabled && this.binding) {
        this.timer = setTimeout(() => { void this.poll(generation); }, 2000);
      }
    }
  }

  async canRetry(trigger: RetryTrigger): Promise<boolean> {
    const generation = this.generation;
    if (!this.binding || trigger.sessionId !== this.binding.sessionResource || !trigger.errorFingerprint) { return false; }
    try {
      const error = await this.getCurrentError();
      // Query the live Agents selection last, after all asynchronous disk I/O.
      const current = await this.currentSession();
      return generation === this.generation && readConfig().enabled && current === trigger.sessionId &&
        error?.errorFingerprint === trigger.errorFingerprint;
    } catch { return false; }
  }

  stop(): void {
    this.generation++;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.binding) { for (const listener of this.recoveryListeners) { listener(this.binding.sessionResource); } }
    this.binding = undefined;
    this.fingerprint = undefined;
    this.status = "Not watching — run Watch Current Agents Session";
  }

  dispose(): void { this.stop(); }
}
