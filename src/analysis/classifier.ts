import Anthropic from '@anthropic-ai/sdk';
import { CLASSIFIER_SYSTEM_PROMPT } from './prompts.js';
import { withTimeout } from '../util/async.js';
import type { TurnHistoryEntry } from '../aggregator/turn.js';

export interface ClassifierResult {
  score: number;   // 0.0 – 1.0
  reason: string;
}

const CLASSIFIER_TIMEOUT_MS = 3000;
const CLASSIFIER_FALLBACK: ClassifierResult = {
  score: 0.5,
  reason: 'Classification timed out',
};

export class Classifier {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey: apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async classify(prompt: string, history?: TurnHistoryEntry[]): Promise<ClassifierResult> {
    const classifyPromise = (async (): Promise<ClassifierResult> => {
      const message = await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        system: CLASSIFIER_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: formatClassifierInput(prompt, history),
          },
        ],
      });

      const content = message.content[0];
      if (content.type !== 'text') {
        return CLASSIFIER_FALLBACK;
      }

      return parseClassifierResponse(content.text);
    })();

    return withTimeout(classifyPromise, CLASSIFIER_TIMEOUT_MS, CLASSIFIER_FALLBACK);
  }
}

export function formatClassifierInput(prompt: string, history?: TurnHistoryEntry[]): string {
  if (!history || history.length === 0) {
    return `User prompt to classify:\n${prompt}`;
  }

  const lines = history.map(
    (h, i) => `Turn ${i + 1}: "${h.prompt}"\n  → ${h.toolSummary}`,
  );

  return `Recent conversation:\n${lines.join('\n')}\n\nUser prompt to classify:\n${prompt}`;
}

function parseClassifierResponse(raw: string): ClassifierResult {
  try {
    // Extract JSON — handle markdown code blocks and nested objects by
    // finding the outermost { … } span rather than using a regex that
    // breaks on nested braces.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) {
      return CLASSIFIER_FALLBACK;
    }

    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('score' in parsed) ||
      !('reason' in parsed)
    ) {
      return CLASSIFIER_FALLBACK;
    }

    const obj = parsed as Record<string, unknown>;
    const score = Number(obj.score);
    const reason = String(obj.reason);

    if (isNaN(score) || score < 0 || score > 1) {
      return CLASSIFIER_FALLBACK;
    }

    return { score, reason };
  } catch {
    return CLASSIFIER_FALLBACK;
  }
}
