import Anthropic from '@anthropic-ai/sdk';
import type { TurnContext } from '../aggregator/turn.js';
import type { ClassifierResult } from './classifier.js';
import {
  PRE_ADVISORY_SYSTEM_PROMPT,
  PRE_ADVISORY_USER_TEMPLATE,
  POST_ADVISORY_SYSTEM_PROMPT,
  POST_ADVISORY_USER_TEMPLATE,
} from './prompts.js';
import { withTimeout } from '../util/async.js';
import { buildToolSummary } from '../aggregator/tools.js';
import { summarizeResponse } from './summarizer.js';

export interface AdvisoryResult {
  text: string;
  aligned?: boolean;  // only set for post-advisory
}

const ADVISORY_TIMEOUT_MS = 10000;

const PRE_ADVISORY_FALLBACK: AdvisoryResult = { text: 'Advisory unavailable (timeout)' };
const POST_ADVISORY_FALLBACK_TIMEOUT: AdvisoryResult = { text: 'Advisory unavailable (timeout)', aligned: undefined };
const POST_ADVISORY_FALLBACK_ERROR: AdvisoryResult = { text: 'Advisory unavailable (error)', aligned: undefined };

export class Advisor {
  private readonly client: Anthropic;
  private readonly preModel: string;
  private readonly postModel: string;

  constructor(options: { apiKey?: string; preModel?: string; postModel?: string } = {}) {
    this.client = new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
    this.preModel = options.preModel ?? 'claude-haiku-4-5';
    this.postModel = options.postModel ?? 'claude-haiku-4-5';
  }

  // Pre-advisory: called when classifier score >= 0.6
  async preAdvisory(prompt: string, classification: ClassifierResult): Promise<AdvisoryResult> {
    const userMessage = PRE_ADVISORY_USER_TEMPLATE
      .replace('{prompt}', prompt)
      .replace('{score}', classification.score.toFixed(2))
      .replace('{reason}', classification.reason);

    const advisoryPromise = (async (): Promise<AdvisoryResult> => {
      const message = await this.client.messages.create({
        model: this.preModel,
        max_tokens: 200,
        system: PRE_ADVISORY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const content = message.content[0];
      if (content.type !== 'text') {
        return PRE_ADVISORY_FALLBACK;
      }

      return { text: content.text.trim() };
    })();

    return withTimeout(advisoryPromise, ADVISORY_TIMEOUT_MS, PRE_ADVISORY_FALLBACK);
  }

  // Post-advisory: called on turn complete
  async postAdvisory(
    context: TurnContext,
    debugLog?: (label: string, body?: string) => void,
  ): Promise<AdvisoryResult> {
    const toolSummary = buildToolSummary(context.toolResults);
    const totalCost = `$${context.totalCostUsd.toFixed(3)}`;
    const totalTokens = (context.totalInputTokens + context.totalOutputTokens).toLocaleString();

    // Optionally enrich the prompt with a Haiku summary of the assistant's response
    let responseSummarySection = '';
    if (context.lastAssistantMessage) {
      try {
        const summary = await summarizeResponse(
          this.client,
          context.prompt,
          context.lastAssistantMessage,
        );
        if (summary) {
          responseSummarySection =
            `\n\n## Claude's Response Summary\n${summary}\n\nConsider whether Claude's response addressed the user's intent.`;
        }
      } catch {
        // Summarization failed — proceed without it (existing behavior)
      }
    }

    const scoreSection = context.classificationScore !== undefined
      ? `\nAmbiguity score: ${context.classificationScore.toFixed(2)}`
      : '';

    const userMessage = POST_ADVISORY_USER_TEMPLATE
      .replace('{prompt}', context.prompt)
      .replace('{toolSummary}', toolSummary)
      .replace('{totalCost}', totalCost)
      .replace('{totalTokens}', totalTokens)
      .replace('{responseSummarySection}', responseSummarySection)
      .replace('{scoreSection}', scoreSection);

    // Point 5: log the exact message being sent to advisor for post-advisory
    debugLog?.('POST input (to advisor)', userMessage);

    const advisoryPromise = (async (): Promise<AdvisoryResult> => {
      const message = await this.client.messages.create({
        model: this.postModel,
        max_tokens: 300,
        system: POST_ADVISORY_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      });

      const content = message.content[0];
      if (content.type !== 'text') {
        return POST_ADVISORY_FALLBACK_ERROR;
      }

      const text = content.text.trim();
      const aligned = text.startsWith('✓') ? true : text.startsWith('✗') ? false : undefined;

      return { text, aligned };
    })();

    return withTimeout(advisoryPromise, ADVISORY_TIMEOUT_MS, POST_ADVISORY_FALLBACK_TIMEOUT);
  }
}
