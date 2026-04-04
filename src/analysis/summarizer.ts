import Anthropic from '@anthropic-ai/sdk';
import { withTimeout } from '../util/async.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SUMMARIZER_SYSTEM_PROMPT = `You are summarizing an AI assistant's response for intent-matching analysis.

Given the user's original prompt and the assistant's full response, produce a 2-3 sentence summary that captures:
1. What the assistant did or decided to do
2. Whether it addressed the user's request or went in a different direction
3. Any notable omissions or misunderstandings

Be factual and concise. Do not editorialize.`;

const MAX_RESPONSE_CHARS = 8000;
const FALLBACK_CHARS = 500;
const SUMMARIZER_TIMEOUT_MS = 3000;

// ─── summarizeResponse ────────────────────────────────────────────────────────

/**
 * Summarize an assistant response using Haiku for use in the post-advisory prompt.
 * On any failure (API error, timeout), falls back to the first 500 chars of the raw response.
 */
export async function summarizeResponse(
  client: Anthropic,
  userPrompt: string,
  assistantResponse: string,
): Promise<string> {
  const fallback = assistantResponse.slice(0, FALLBACK_CHARS);

  const truncated =
    assistantResponse.length > MAX_RESPONSE_CHARS
      ? assistantResponse.slice(0, MAX_RESPONSE_CHARS)
      : assistantResponse;

  const summarizePromise: Promise<string> = (async (): Promise<string> => {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: SUMMARIZER_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `## User Prompt\n${userPrompt}\n\n## Assistant Response\n${truncated}`,
        },
      ],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      return fallback;
    }

    return content.text.trim();
  })().catch(() => fallback);

  return withTimeout(summarizePromise, SUMMARIZER_TIMEOUT_MS, fallback);
}
