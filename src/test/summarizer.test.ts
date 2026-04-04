import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { summarizeResponse } from '../analysis/summarizer.js';

// ── Mock helpers ───────────────────────────────────────────────────────────────

type CreateArgs = Parameters<Anthropic['messages']['create']>[0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFn = (args: CreateArgs) => Promise<any>;

function makeClient(handler: AnyFn): Anthropic {
  return {
    messages: { create: handler },
  } as unknown as Anthropic;
}

function makeSuccessClient(text: string, captureArgs?: (args: CreateArgs) => void): Anthropic {
  return makeClient(async (args) => {
    captureArgs?.(args);
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-4-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [{ type: 'text', text, citations: [] }],
    };
  });
}

function makeErrorClient(error: Error): Anthropic {
  return makeClient(async () => {
    throw error;
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('summarizeResponse', () => {
  test('returns summarized text from Haiku on success', async () => {
    const client = makeSuccessClient('The assistant refactored the auth module as requested.');
    const result = await summarizeResponse(client, 'refactor the auth module', 'I have refactored...');
    assert.equal(result, 'The assistant refactored the auth module as requested.');
  });

  test('truncates assistantResponse to 8000 chars before sending', async () => {
    let capturedContent = '';
    const client = makeSuccessClient('summary', (args) => {
      const msg = args.messages[0];
      capturedContent = typeof msg.content === 'string' ? msg.content : '';
    });

    const longResponse = 'x'.repeat(10000);
    await summarizeResponse(client, 'test prompt', longResponse);

    // The truncated response should appear in the user message
    assert.ok(capturedContent.includes('x'.repeat(8000)), 'should include 8000 x chars');
    assert.ok(!capturedContent.includes('x'.repeat(8001)), 'should not include 8001 x chars');
  });

  test('does not truncate responses at or under 8000 chars', async () => {
    let capturedContent = '';
    const client = makeSuccessClient('summary', (args) => {
      const msg = args.messages[0];
      capturedContent = typeof msg.content === 'string' ? msg.content : '';
    });

    const exactResponse = 'y'.repeat(8000);
    await summarizeResponse(client, 'test prompt', exactResponse);

    assert.ok(capturedContent.includes('y'.repeat(8000)), 'should include full 8000 chars');
  });

  test('falls back to first 500 chars of raw response on API error', async () => {
    const client = makeErrorClient(new Error('API unavailable'));
    const response = 'a'.repeat(1000);
    const result = await summarizeResponse(client, 'test prompt', response);

    assert.equal(result, 'a'.repeat(500));
  });

  test('fallback is first 500 chars (shorter if response is shorter)', async () => {
    const client = makeErrorClient(new Error('network error'));
    const shortResponse = 'short response text';
    const result = await summarizeResponse(client, 'test prompt', shortResponse);

    assert.equal(result, shortResponse);
  });

  test('sends only user prompt and assistant response — no leakage of other data', async () => {
    let capturedArgs: CreateArgs | undefined;
    const client = makeSuccessClient('summary', (args) => {
      capturedArgs = args;
    });

    await summarizeResponse(client, 'my user prompt', 'assistant said this');

    assert.ok(capturedArgs !== undefined, 'handler should have been called');
    const args = capturedArgs as CreateArgs;

    // Only one user message
    assert.equal(args.messages.length, 1);
    assert.equal(args.messages[0].role, 'user');

    const content = args.messages[0].content as string;
    assert.ok(content.includes('my user prompt'), 'should include user prompt');
    assert.ok(content.includes('assistant said this'), 'should include assistant response');

    // Correct model and token cap
    assert.equal(args.model, 'claude-haiku-4-5');
    assert.equal(args.max_tokens, 200);
  });

  test('falls back on timeout (slow API)', async () => {
    const slowClient = makeClient(
      () => new Promise((resolve) => setTimeout(resolve, 10000)), // 10s — well past 3s timeout
    );

    const response = 'b'.repeat(600);
    const result = await summarizeResponse(slowClient, 'test prompt', response);

    // Should fall back to first 500 chars
    assert.equal(result, 'b'.repeat(500));
  });
});
