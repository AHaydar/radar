import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TurnContext } from '../aggregator/turn.js';
import type { ClassifierResult } from '../analysis/classifier.js';
import type { AdvisoryResult } from '../analysis/advisor.js';

const HISTORY_DIR = join(homedir(), '.config', 'radar', 'history');

export function appendTurn(
  ctx: TurnContext,
  classification: ClassifierResult | null,
  preAdvisory: AdvisoryResult | null,
  postAdvisory: AdvisoryResult | null,
  dir = HISTORY_DIR,
): void {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const entry = {
    ts: now.toISOString(),
    sessionId: ctx.sessionId,
    promptId: ctx.promptId,
    prompt: ctx.prompt,
    promptLength: ctx.promptLength,
    tools: ctx.toolResults.map((t) => ({
      name: t.toolName,
      success: t.success,
      durationMs: t.durationMs,
      ...(t.bashCommand !== undefined ? { bashCommand: t.bashCommand } : {}),
    })),
    toolNames: ctx.toolNames,
    totalCostUsd: ctx.totalCostUsd,
    totalInputTokens: ctx.totalInputTokens,
    totalOutputTokens: ctx.totalOutputTokens,
    errors: ctx.errors,
    classification: classification ? { score: classification.score, reason: classification.reason } : null,
    preAdvisory: preAdvisory ? { text: preAdvisory.text } : null,
    postAdvisory: postAdvisory ? { text: postAdvisory.text, aligned: postAdvisory.aligned } : null,
    durationMs: Date.now() - ctx.startedAt,
  };

  appendFileSync(join(dir, `${dateStr}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
}
