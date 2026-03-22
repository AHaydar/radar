import { OtlpReceiver } from '../receiver/otlp.js';
import type { RadarEvent } from '../receiver/otlp.js';
import { TurnAggregator } from '../aggregator/turn.js';
import type { TurnContext } from '../aggregator/turn.js';
import { Classifier } from '../analysis/classifier.js';
import { Advisor } from '../analysis/advisor.js';
import {
  printBanner,
  printPreClear,
  printPreAdvisory,
  printPostAligned,
  printPostMisaligned,
  printWarning,
  printError,
} from '../output/formatter.js';

export interface WatchOptions {
  port?: number;
  boundaryTimeoutMs?: number;
  scoreThreshold?: number;
  apiKey?: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startWatch(options: WatchOptions = {}): Promise<void> {
  const port = options.port ?? 4820;
  const scoreThreshold = options.scoreThreshold ?? 0.6;

  const receiver = new OtlpReceiver(port);
  const aggregator = new TurnAggregator({
    boundaryTimeoutMs: options.boundaryTimeoutMs ?? 5000,
  });
  const classifier = new Classifier(options.apiKey);
  const advisor = new Advisor(options.apiKey);

  // Track whether we've seen any events without prompt content — warn once
  let warnedAboutMissingPrompt = false;
  // Prevent double-classification if the same promptId is seen more than once
  const classifying = new Set<string>();

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

    void runPreAdvisory(event.prompt, event.promptId);
  });

  receiver.on('error', (err: Error) => {
    printError(`OTLP server error: ${err.message}`);
  });

  // ── Wire: TurnAggregator → post-advisory ───────────────────────────────────
  aggregator.on('turn_complete', (ctx: TurnContext) => {
    void runPostAdvisory(ctx);
  });

  // ── Pre-advisory pipeline ───────────────────────────────────────────────────
  async function runPreAdvisory(prompt: string, promptId: string): Promise<void> {
    try {
      if (!prompt) return; // no prompt text — skip silently

      const result = await classifier.classify(prompt);

      if (result.score < scoreThreshold) {
        printPreClear(result.score);
        return;
      }

      // Score >= threshold: escalate to Sonnet
      const advisory = await advisor.preAdvisory(prompt, result);
      printPreAdvisory(result.score, advisory.text);
    } catch (err) {
      printError(`Pre-advisory failed for prompt ${promptId}: ${errMsg(err)}`);
    } finally {
      // Always release the deduplication guard once pre-advisory finishes,
      // whether it succeeded, failed, or was skipped due to missing prompt.
      classifying.delete(promptId);
    }
  }

  // ── Post-advisory pipeline ──────────────────────────────────────────────────
  async function runPostAdvisory(ctx: TurnContext): Promise<void> {
    if (!ctx.prompt) return; // no prompt text — skip silently

    try {
      const result = await advisor.postAdvisory(ctx);

      if (result.aligned === false) {
        printPostMisaligned(result.text);
      } else {
        printPostAligned(result.text);
      }
    } catch (err) {
      printError(`Post-advisory failed for prompt ${ctx.promptId}: ${errMsg(err)}`);
    }
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
