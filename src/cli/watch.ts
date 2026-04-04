import { OtlpReceiver } from '../receiver/otlp.js';
import type { RadarEvent } from '../receiver/otlp.js';
import { TurnAggregator } from '../aggregator/turn.js';
import type { TurnContext, SessionSummary, TurnHistoryEntry } from '../aggregator/turn.js';
import { Classifier, formatClassifierInput } from '../analysis/classifier.js';
import { Advisor } from '../analysis/advisor.js';
import { buildToolSummary } from '../aggregator/tools.js';
import {
  printBanner,
  printPreClear,
  printPreAdvisory,
  printPostAligned,
  printPostMisaligned,
  printSessionStart,
  printSuppressedCount,
  printWarning,
  printError,
  printDebug,
} from '../output/formatter.js';

export interface WatchOptions {
  port?: number;
  scoreThreshold?: number;
  apiKey?: string;
  verbose?: boolean;
  debug?: boolean;
}

/**
 * Determine whether an event type should be suppressed in alert-only mode.
 * Always returns false in verbose mode.
 */
export function shouldSuppress(
  type: 'pre-clear' | 'post-aligned' | 'alert',
  verbose: boolean,
): boolean {
  if (verbose) return false;
  return type !== 'alert';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startWatch(options: WatchOptions = {}): Promise<void> {
  const port = options.port ?? 4820;
  const scoreThreshold = options.scoreThreshold ?? 0.6;
  const verbose = options.verbose ?? false;
  const debug = options.debug ?? false;

  /** Only emit when --debug is active. */
  function dbg(label: string, body?: string): void {
    if (debug) printDebug(label, body);
  }

  const receiver = new OtlpReceiver(port);
  const aggregator = new TurnAggregator();
  const classifier = new Classifier(options.apiKey);
  const advisor = new Advisor(options.apiKey);

  // Track whether we've seen any events without prompt content — warn once
  let warnedAboutMissingPrompt = false;
  // Prevent double-classification if the same promptId is seen more than once
  const classifying = new Set<string>();
  // Map sessionId → display label ("S1", "S2", …)
  const sessionLabels = new Map<string, string>();
  // Count of suppressed clear/aligned events (alert-only mode)
  let suppressedCount = 0;

  /** Flush the suppressed-events counter before printing any alert line. */
  function flushSuppressed(): void {
    if (suppressedCount > 0) {
      printSuppressedCount(suppressedCount);
      suppressedCount = 0;
    }
  }

  // ── Wire: session_start → label tracking + display ────────────────────────
  aggregator.on('session_start', (s: SessionSummary) => {
    sessionLabels.set(s.sessionId, s.label);
    flushSuppressed();
    printSessionStart(s.label, s.sessionId);
  });

  // ── Wire: OtlpReceiver → TurnAggregator + classification ───────────────────
  //
  // A single listener handles both jobs in order: aggregation first so that
  // TurnContext exists by the time classification starts, then classification
  // for user_prompt events.
  receiver.on('event', (event: RadarEvent) => {
    // 1. Always feed the aggregator
    aggregator.addEvent(event);

    // 2. On user_prompt, trigger pre-advisory (fire-and-forget)
    if (event.type !== 'user_prompt') return;

    if (classifying.has(event.promptId)) return;
    classifying.add(event.promptId);

    if (!event.prompt && !warnedAboutMissingPrompt) {
      warnedAboutMissingPrompt = true;
      printWarning(
        'Prompt content not available. Set OTEL_LOG_USER_PROMPTS=1 to enable intent analysis.',
      );
    }

    void runPreAdvisory(
      event.prompt,
      event.promptId,
      aggregator.getRecentTurns(event.sessionId),
      sessionLabels.get(event.sessionId),
    );
  });

  receiver.on('error', (err: Error) => {
    printError(`OTLP server error: ${err.message}`);
  });

  // ── Wire: Stop hook → turn completion ──────────────────────────────────────
  // Uses scheduleCompletion (not completeTurn directly) to handle the race
  // between the Stop hook and OTel's export interval (2s): the stop signal
  // often arrives before telemetry events are flushed.
  receiver.on('stop', (sessionId: string, lastAssistantMessage?: string) => {
    aggregator.scheduleCompletion(sessionId, lastAssistantMessage);
  });

  // ── Wire: TurnAggregator → post-advisory ───────────────────────────────────
  aggregator.on('turn_complete', (ctx: TurnContext) => {
    void runPostAdvisory(ctx, sessionLabels.get(ctx.sessionId));
  });

  // ── Pre-advisory pipeline ───────────────────────────────────────────────────
  async function runPreAdvisory(
    prompt: string,
    promptId: string,
    history: TurnHistoryEntry[],
    sessionLabel?: string,
  ): Promise<void> {
    try {
      if (!prompt) return; // no prompt text — skip silently

      // [1] When the pre-advisory pipeline is triggered
      const preview = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
      dbg(`PRE triggered — promptId=${promptId}  session=${sessionLabel ?? '—'}  prompt: "${preview}"`);

      // [2] What we're sending to Haiku as classifier input
      dbg('CLASSIFIER input', formatClassifierInput(prompt, history));

      const result = await classifier.classify(prompt, history);

      // [3] What Haiku returned
      dbg(`HAIKU response — score=${result.score.toFixed(2)}  reason: ${result.reason}`);

      if (result.score < scoreThreshold) {
        dbg(`score below threshold (${result.score.toFixed(2)} < ${scoreThreshold.toFixed(2)}) — pre-advisory suppressed`);
        if (verbose) {
          printPreClear(result.score, sessionLabel);
        } else {
          suppressedCount++;
        }
        return;
      }

      // Score >= threshold: flush suppressed count, then escalate to Sonnet
      dbg(`score above threshold — escalating to Sonnet for pre-advisory text`);
      flushSuppressed();
      const advisory = await advisor.preAdvisory(prompt, result);
      printPreAdvisory(result.score, advisory.text, sessionLabel);
    } catch (err) {
      printError(`Pre-advisory failed for prompt ${promptId}: ${errMsg(err)}`);
    } finally {
      // Always release the deduplication guard once pre-advisory finishes,
      // whether it succeeded, failed, or was skipped due to missing prompt.
      classifying.delete(promptId);
    }
  }

  // ── Post-advisory pipeline ──────────────────────────────────────────────────
  async function runPostAdvisory(ctx: TurnContext, sessionLabel?: string): Promise<void> {
    if (!ctx.prompt) return; // no prompt text — skip silently

    try {
      // [4] What we gathered from the completed turn
      const toolSummary = buildToolSummary(ctx.toolResults);
      const totalTokens = ctx.totalInputTokens + ctx.totalOutputTokens;
      dbg(
        `POST gathering — tools: "${toolSummary}" | cost: $${ctx.totalCostUsd.toFixed(3)} | ` +
        `tokens: ${totalTokens.toLocaleString()} | ` +
        `assistant msg: ${ctx.lastAssistantMessage ? `yes (${ctx.lastAssistantMessage.length} chars)` : 'no'}`,
      );

      // [5] What we're sending to Sonnet for post-advisory (logged inside advisor)
      const result = await advisor.postAdvisory(ctx, debug ? dbg : undefined);

      // [6] When the result is sent to the terminal
      if (result.aligned === false) {
        dbg(`POST displayed — misaligned → showing red box`);
        flushSuppressed();
        printPostMisaligned(result.text, sessionLabel);
      } else if (result.aligned === true) {
        if (verbose) {
          dbg(`POST displayed — aligned → showing green line`);
          printPostAligned(result.text, sessionLabel);
        } else {
          dbg(`POST displayed — aligned, suppressed (alert-only mode)`);
          suppressedCount++;
        }
      } else {
        // aligned is undefined: timeout, error, or unexpected model format —
        // surface as a warning rather than silently showing a green box.
        dbg(`POST displayed — alignment unclear → showing warning`);
        flushSuppressed();
        printWarning(`Post-advisory: ${result.text}`);
      }
    } catch (err) {
      printError(`Post-advisory failed for prompt ${ctx.promptId}: ${errMsg(err)}`);
    }
  }

  // ── OTel env var check ─────────────────────────────────────────────────────
  const requiredOtelVars = [
    'CLAUDE_CODE_ENABLE_TELEMETRY',
    'OTEL_LOGS_EXPORTER',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  ];
  const missingVars = requiredOtelVars.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    printWarning('OTel env vars not configured. Run `radar setup` and restart Claude Code.');
  }

  // ── Start ───────────────────────────────────────────────────────────────────
  try {
    await receiver.start();
  } catch (err) {
    const msg = errMsg(err);
    if (msg.includes('EADDRINUSE')) {
      printError(`Port ${port} is already in use. Use --port <n> to choose a different port.`);
    } else {
      printError(`Failed to start OTLP receiver: ${msg}`);
    }
    process.exit(1);
  }

  printBanner(port);

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  async function shutdown(): Promise<void> {
    process.stdout.write('\n');
    printWarning('Shutting down Radar...');
    await receiver.stop();
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
