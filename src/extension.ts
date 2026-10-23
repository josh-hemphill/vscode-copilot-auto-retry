import * as vscode from "vscode";
import { Logger } from "./logger";
import { readConfig, setEnabled } from "./configuration";
import { RetryEngine } from "./retryEngine";
import { Guardrails } from "./guardrails";
import { ActiveSessionResolver } from "./activeSessionResolver";
import { NetworkMonitor } from "./networkMonitor";
import { SessionWatcher } from "./sessionWatcher";
import { StatusBar } from "./statusBar";
import { AgentsWindow, isAgentsWindow } from "./agentsWindow";

/**
 * Extension entry point.
 *
 * Architecture:
 *
 *   SessionWatcher ──▶ RetryEngine ──▶ chat.submit (focus + send prompt)
 *   (filesystem)          │
 *        ▲                ▼
 *        │            Guardrails
 *   NetworkMonitor        │
 *        │                │
 *        └────────────────┘
 *             StatusBar (read-only view)
 *
 * The SessionWatcher monitors Copilot's chat session JSONL files on disk to
 * detect when a conversation has a failed response with a retryable error
 * (e.g., network error, rate limit). This is the PRIMARY error detection
 * mechanism — it gives direct visibility into conversation error state,
 * unlike the previous approach of inferring errors from service health.
 *
 * The NetworkMonitor provides a secondary signal: when connectivity drops
 * and recovers, it triggers a retry in case a chat request failed during
 * the outage and the session file hasn't been updated yet.
 *
 * The extension activates lazily (onStartupFinished) and begins watching
 * session files immediately. When a retryable error is detected, the retry
 * engine fires with bounded exponential backoff.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new Logger();
  logger.info("Copilot Auto-Retry activating...");

  const inAgentsWindow = await isAgentsWindow();
  const agentsWindow = new AgentsWindow(logger, context.workspaceState);
  logger.info(`Window: ${inAgentsWindow ? "Agents" : "workbench"}`);

  const guardrails = new Guardrails(logger);
  const activeSessionResolver = new ActiveSessionResolver(logger);
  if (!inAgentsWindow) { activeSessionResolver.initialize(context.storageUri); }
  const retryEngine = new RetryEngine(logger, guardrails, activeSessionResolver, agentsWindow);
  const networkMonitor = new NetworkMonitor(logger);
  const sessionWatcher = new SessionWatcher(logger);
  const statusBar = new StatusBar(logger);

  function refreshStatus(): void {
    statusBar.updateDisplay(retryEngine.getState(), retryEngine.getCurrentAttempt(),
      readConfig().maxRetries, retryEngine.getNextRetryAt());
  }

  async function startMonitoring(): Promise<void> {
    if (inAgentsWindow) {
      await agentsWindow.restore();
    } else {
      networkMonitor.start();
      await sessionWatcher.start(context.storageUri);
    }
  }

  agentsWindow.onError(error => {
    if (readConfig().enabled) { void retryEngine.triggerRetryCycle(RetryEngine.triggerFromSessionError(error)); }
  });
  agentsWindow.onRecovery(session => retryEngine.cancelActiveCycle("Agents error superseded or watch stopped", session));
  context.subscriptions.push(agentsWindow);
  context.subscriptions.push(vscode.commands.registerCommand("copilotAutoRetry.watchAgentsSession", async () => {
    if (!inAgentsWindow) {
      vscode.window.showWarningMessage("Open the Agents window and select your Copilot conversation first.");
      return;
    }
    if (!readConfig().enabled) {
      vscode.window.showWarningMessage("Enable Copilot Auto-Retry first.");
      return;
    }
    try {
      await agentsWindow.watchCurrentSession();
      logger.show();
      vscode.window.showInformationMessage("Watching this Copilot Agents conversation for daily quota errors. Run Show Status to inspect detection and the next retry time.");
    } catch (error) {
      vscode.window.showWarningMessage(error instanceof Error ? error.message : "Unable to watch this Agents session.");
    }
  }));

  // ── Primary error detection: session file watcher ──────────────────────
  //
  // The SessionWatcher monitors `chatSessions/*.jsonl` files in VS Code's
  // workspace storage. When a chat request result contains `errorDetails`
  // with a retryable error code (e.g., "networkError") and a "Try Again"
  // confirmation button, the watcher emits a retryable error event.
  //
  // This is the most reliable signal available: it reads the same data that
  // populates the "Try Again" button in the chat UI.

  sessionWatcher.onRetryableError((sessionError) => {
    const config = readConfig();
    if (!config.enabled) {
      return;
    }

    logger.info(
      `Session watcher detected retryable error: code=${sessionError.errorCode} ` +
      `in session ${sessionError.sessionId}`,
    );

    const trigger = RetryEngine.triggerFromSessionError(sessionError);
    void retryEngine.triggerRetryCycle(trigger);
  });

  // When the session watcher detects that a previously-errored session now
  // has a successful result, cancel any active retry cycle for it.
  sessionWatcher.onRecovery((sessionId) => {
    logger.info(
      `Session ${sessionId} recovered — cancelling retry if active`,
    );
    retryEngine.cancelActiveCycle(`session ${sessionId} recovered`, sessionId);
  });

  // ── Secondary signal: network recovery ─────────────────────────────────
  //
  // Chat panel errors like "net::ERR_NETWORK_CHANGED" are invisible to the
  // extension API. The session file usually gets updated with errorDetails,
  // but network recovery is still a useful secondary trigger in case the
  // session file write is delayed.

  networkMonitor.onRecovery(() => {
    const config = readConfig();
    if (!config.enabled) {
      return;
    }

    // Only trigger a retry if the session watcher has detected an
    // unresolved error in THIS window's chat sessions.  Without this
    // gate, every open VS Code window would fire a retry when the
    // network recovers — even windows where no chat request failed.
    if (!sessionWatcher.hasActiveErrors()) {
      logger.info(
        "Network recovered but no active session errors in this window — skipping retry",
      );
      return;
    }

    logger.info(
      "Network recovered after outage — triggering retry for active session error",
    );

    const trigger = RetryEngine.triggerFromNetworkRecovery();
    void retryEngine.triggerRetryCycle(trigger);
  });

  // Wire network state into logging
  networkMonitor.onStateChange((state) => {
    if (state === "offline") {
      logger.warn("Network offline detected — watching for recovery");
    }
  });

  // Wire retry engine state changes → status bar
  retryEngine.onStateChange((state) => {
    const config = readConfig();
    statusBar.updateDisplay(
      state,
      retryEngine.getCurrentAttempt(),
      config.maxRetries,
      retryEngine.getNextRetryAt(),
    );
  });

  // ── Commands ───────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.enable", async () => {
      await setEnabled(true);
      guardrails.reset();
      await startMonitoring();
      refreshStatus();
      logger.info("Extension enabled by user");
      vscode.window.showInformationMessage("Copilot Auto-Retry enabled.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.disable", async () => {
      await setEnabled(false);
      retryEngine.cancelActiveCycle("disabled by user");
      networkMonitor.stop();
      sessionWatcher.stop();
      agentsWindow.stop();
      statusBar.updateDisplay("disabled");
      logger.info("Extension disabled by user");
      vscode.window.showInformationMessage("Copilot Auto-Retry disabled.");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilotAutoRetry.toggleEnabled",
      async () => {
        const config = readConfig();
        if (config.enabled) {
          await vscode.commands.executeCommand("copilotAutoRetry.disable");
        } else {
          await vscode.commands.executeCommand("copilotAutoRetry.enable");
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.showStatus", async () => {
      const config = readConfig();
      const engineState = retryEngine.getState();
      const consecutiveFailures = guardrails.getConsecutiveFailures();

      const lines: string[] = [
        `Enabled: ${config.enabled}`,
        `Engine state: ${engineState}`,
        `Network: ${networkMonitor.getState()}`,
        `Max retries: ${config.maxRetries}`,
        `Base delay: ${config.baseDelayMs}ms`,
        `Daily quota fallback: ${config.dailyQuotaRetryDelayHours} hours`,
        `Next retry: ${retryEngine.getNextRetryAt() ? new Date(retryEngine.getNextRetryAt()!).toLocaleString() : "none"}`,
        `Consecutive failures: ${consecutiveFailures}`,
        `Window: ${inAgentsWindow ? "Agents" : "workbench"}`,
        `Detection: ${inAgentsWindow ? agentsWindow.getStatus() : "session file watcher + network monitor"}`,
        `Retry method: ${inAgentsWindow ? "Agents conversation submit (preserves model and draft)" : "chat submit (focus + follow-up prompt)"}`,
      ];

      logger.show();
      logger.info(`Status report:\n  ${lines.join("\n  ")}`);
      vscode.window.showInformationMessage(
        `Copilot Auto-Retry: ${engineState} | Network: ${networkMonitor.getState()} | Failed cycles: ${consecutiveFailures}`,
      );
    }),
  );

  // Manual retry trigger — for when the user sees an error but auto-detection
  // hasn't fired (e.g., session file write is delayed or the error type is
  // not in our retryable list).
  context.subscriptions.push(
    vscode.commands.registerCommand("copilotAutoRetry.retryNow", async () => {
      const config = readConfig();
      if (!config.enabled) {
        vscode.window.showWarningMessage(
          "Copilot Auto-Retry is disabled. Enable it first.",
        );
        return;
      }

      logger.info("Manual retry triggered by user");

      // If a cycle is already running, inform the user
      if (retryEngine.getState() !== "idle") {
        vscode.window.showInformationMessage(
          `Copilot Auto-Retry: already ${retryEngine.getState()} ` +
          `(attempt ${retryEngine.getCurrentAttempt()}/${config.maxRetries})`,
        );
        return;
      }

      if (inAgentsWindow) {
        try {
          const error = await agentsWindow.getCurrentError();
          if (!error) {
            vscode.window.showWarningMessage("No daily quota error in the watched Agents session. Run Watch Current Agents Session first.");
            return;
          }
          await retryEngine.triggerRetryCycle(RetryEngine.triggerFromSessionError(error));
        } catch {
          vscode.window.showWarningMessage("Unable to read the watched Agents session. Run Watch Current Agents Session again.");
        }
      } else {
        await retryEngine.triggerRetryCycle(RetryEngine.triggerFromManualAction());
      }
    }),
  );

  // Dev command: simulate a session error to test the full retry pipeline.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "copilotAutoRetry.simulateError",
      async () => {
        const config = readConfig();
        if (!config.enabled) {
          vscode.window.showWarningMessage(
            "Copilot Auto-Retry is disabled. Enable it first.",
          );
          return;
        }

        if (inAgentsWindow) {
          vscode.window.showWarningMessage("Simulation is only available in the workbench. Use Watch Current Agents Session for the Copilot harness.");
          return;
        }
        logger.show();
        logger.info("=== SIMULATION START ===");
        logger.info(
          "Injecting synthetic session error into the retry pipeline...",
        );
        logger.info(
          "Retry method: focus chat panel → submit follow-up prompt",
        );

        const trigger: ReturnType<typeof RetryEngine.triggerFromSessionError> = {
          source: "session-error",
          errorCode: "networkError",
          detail: "[SIMULATED] Network error in chat session",
          timestamp: Date.now(),
        };

        vscode.window.showInformationMessage(
          "Copilot Auto-Retry: simulating error. Watch the output channel and status bar.",
        );

        await retryEngine.triggerRetryCycle(trigger);
        logger.info(
          "Retry cycle triggered. Watch the status bar and output channel for progress.",
        );
      },
    ),
  );

  // React to configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("copilotAutoRetry")) {
        return;
      }

      logger.info("Configuration changed — applying");
      const config = readConfig();

      if (!config.enabled) {
        retryEngine.cancelActiveCycle("disabled via settings");
        networkMonitor.stop();
        sessionWatcher.stop();
        agentsWindow.stop();
        statusBar.updateDisplay("disabled");
      } else {
        void startMonitoring();
        refreshStatus();
      }
    }),
  );

  // Register disposables
  context.subscriptions.push(retryEngine);
  context.subscriptions.push(networkMonitor);
  context.subscriptions.push(sessionWatcher);
  context.subscriptions.push(statusBar);
  context.subscriptions.push({ dispose: () => logger.dispose() });

  // Initial startup
  const config = readConfig();

  if (config.enabled) {
    await startMonitoring();
    refreshStatus();
  } else {
    statusBar.updateDisplay("disabled");
  }

  logger.info("Copilot Auto-Retry activated (detection: session file watcher)");
}

export function deactivate(): void {
  // All cleanup is handled via context.subscriptions disposables
}
