import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendTurn } from '../output/history.js';
import type { TurnContext } from '../aggregator/turn.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTurnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    promptId: 'test-prompt-1',
    sessionId: 'test-session-1',
    prompt: 'refactor the auth module',
    promptLength: 24,
    startedAt: Date.now() - 5000,
    toolResults: [
      { toolName: 'Edit', success: true, durationMs: 450 },
      { toolName: 'Read', success: true, durationMs: 120 },
    ],
    apiRequests: [
      { model: 'claude-sonnet-4-5', costUsd: 0.003, inputTokens: 847, outputTokens: 312, durationMs: 2000 },
    ],
    errors: [],
    toolDecisions: [],
    lastAssistantMessage: 'Done — refactored the auth module.',
    totalCostUsd: 0.003,
    totalInputTokens: 847,
    totalOutputTokens: 312,
    toolNames: ['Edit', 'Read'],
    ...overrides,
  };
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function readEntries(dir: string): Record<string, unknown>[] {
  const raw = readFileSync(join(dir, `${todayStr()}.jsonl`), 'utf8');
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'radar-history-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('appendTurn', () => {
  test('creates the directory if it does not exist', () => {
    const dir = join(tmpDir, 'nested', 'history');
    appendTurn(makeTurnContext(), null, null, null, dir);

    const entries = readEntries(dir);
    assert.equal(entries.length, 1);
  });

  test('writes required top-level fields', () => {
    appendTurn(makeTurnContext(), null, null, null, tmpDir);

    const [entry] = readEntries(tmpDir);
    assert.ok(typeof entry['ts'] === 'string', 'ts should be a string');
    assert.equal(entry['sessionId'], 'test-session-1');
    assert.equal(entry['promptId'], 'test-prompt-1');
    assert.equal(entry['prompt'], 'refactor the auth module');
    assert.equal(entry['promptLength'], 24);
    assert.equal(entry['totalCostUsd'], 0.003);
    assert.equal(entry['totalInputTokens'], 847);
    assert.equal(entry['totalOutputTokens'], 312);
    assert.deepEqual(entry['errors'], []);
    assert.ok(typeof entry['durationMs'] === 'number' && (entry['durationMs'] as number) >= 0);
  });

  test('ts is a valid ISO 8601 timestamp', () => {
    appendTurn(makeTurnContext(), null, null, null, tmpDir);
    const [entry] = readEntries(tmpDir);
    assert.ok(!isNaN(Date.parse(entry['ts'] as string)));
  });

  test('durationMs reflects elapsed time since startedAt', () => {
    const startedAt = Date.now() - 6000;
    appendTurn(makeTurnContext({ startedAt }), null, null, null, tmpDir);

    const [entry] = readEntries(tmpDir);
    const duration = entry['durationMs'] as number;
    assert.ok(duration >= 6000, `durationMs (${duration}) should be >= 6000`);
    assert.ok(duration < 10000, `durationMs (${duration}) should be < 10000`);
  });

  test('serialises tool results with name, success, durationMs', () => {
    appendTurn(makeTurnContext(), null, null, null, tmpDir);

    const [entry] = readEntries(tmpDir);
    const tools = entry['tools'] as Array<Record<string, unknown>>;
    assert.equal(tools.length, 2);
    assert.equal(tools[0]['name'], 'Edit');
    assert.equal(tools[0]['success'], true);
    assert.equal(tools[0]['durationMs'], 450);
    assert.equal(tools[1]['name'], 'Read');
  });

  test('includes bashCommand when present on a tool result', () => {
    const ctx = makeTurnContext({
      toolResults: [{ toolName: 'Bash', success: true, durationMs: 300, bashCommand: 'npm test' }],
      toolNames: ['Bash'],
    });
    appendTurn(ctx, null, null, null, tmpDir);

    const [entry] = readEntries(tmpDir);
    const tools = entry['tools'] as Array<Record<string, unknown>>;
    assert.equal(tools[0]['bashCommand'], 'npm test');
  });

  test('omits bashCommand key when not present on a tool result', () => {
    appendTurn(makeTurnContext(), null, null, null, tmpDir);

    const [entry] = readEntries(tmpDir);
    const tools = entry['tools'] as Array<Record<string, unknown>>;
    assert.ok(!('bashCommand' in tools[0]), 'Edit tool should not have bashCommand key');
  });

  test('writes classification score and reason when provided', () => {
    appendTurn(
      makeTurnContext(),
      { score: 0.78, reason: 'vague intent' },
      null,
      null,
      tmpDir,
    );

    const [entry] = readEntries(tmpDir);
    const cl = entry['classification'] as Record<string, unknown>;
    assert.equal(cl['score'], 0.78);
    assert.equal(cl['reason'], 'vague intent');
  });

  test('writes null classification when not provided', () => {
    appendTurn(makeTurnContext(), null, null, null, tmpDir);
    const [entry] = readEntries(tmpDir);
    assert.equal(entry['classification'], null);
  });

  test('writes preAdvisory text when provided', () => {
    appendTurn(makeTurnContext(), null, { text: '⚠ ambiguous prompt' }, null, tmpDir);

    const [entry] = readEntries(tmpDir);
    const pre = entry['preAdvisory'] as Record<string, unknown>;
    assert.equal(pre['text'], '⚠ ambiguous prompt');
  });

  test('writes null preAdvisory when not provided', () => {
    appendTurn(makeTurnContext(), null, null, null, tmpDir);
    const [entry] = readEntries(tmpDir);
    assert.equal(entry['preAdvisory'], null);
  });

  test('writes postAdvisory with aligned: true', () => {
    appendTurn(makeTurnContext(), null, null, { text: '✓ aligned', aligned: true }, tmpDir);

    const [entry] = readEntries(tmpDir);
    const post = entry['postAdvisory'] as Record<string, unknown>;
    assert.equal(post['text'], '✓ aligned');
    assert.equal(post['aligned'], true);
  });

  test('writes postAdvisory with aligned: false', () => {
    appendTurn(makeTurnContext(), null, null, { text: '✗ misaligned', aligned: false }, tmpDir);

    const [entry] = readEntries(tmpDir);
    const post = entry['postAdvisory'] as Record<string, unknown>;
    assert.equal(post['aligned'], false);
  });

  test('writes null postAdvisory when not provided', () => {
    appendTurn(makeTurnContext(), null, null, null, tmpDir);
    const [entry] = readEntries(tmpDir);
    assert.equal(entry['postAdvisory'], null);
  });

  test('appends multiple entries to the same file', () => {
    appendTurn(makeTurnContext({ promptId: 'p1' }), null, null, null, tmpDir);
    appendTurn(makeTurnContext({ promptId: 'p2' }), null, null, null, tmpDir);
    appendTurn(makeTurnContext({ promptId: 'p3' }), null, null, null, tmpDir);

    const entries = readEntries(tmpDir);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]['promptId'], 'p1');
    assert.equal(entries[1]['promptId'], 'p2');
    assert.equal(entries[2]['promptId'], 'p3');
  });

  test('each line is valid standalone JSON', () => {
    appendTurn(makeTurnContext({ promptId: 'a' }), null, null, null, tmpDir);
    appendTurn(makeTurnContext({ promptId: 'b' }), null, null, null, tmpDir);

    const raw = readFileSync(join(tmpDir, `${todayStr()}.jsonl`), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `line should be valid JSON: ${line}`);
    }
  });

  test("file is named after today's date (YYYY-MM-DD.jsonl)", () => {
    appendTurn(makeTurnContext(), null, null, null, tmpDir);
    // readEntries would throw if the file doesn't exist under today's name
    assert.doesNotThrow(() => readEntries(tmpDir));
  });

  test('survives a corrupt line already in the file — does not throw', () => {
    // Pre-seed the file with a corrupt line
    appendFileSync(join(tmpDir, `${todayStr()}.jsonl`), 'not valid json\n', 'utf8');

    // appendTurn should still succeed (it only appends, never reads)
    assert.doesNotThrow(() => appendTurn(makeTurnContext(), null, null, null, tmpDir));

    const raw = readFileSync(join(tmpDir, `${todayStr()}.jsonl`), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    // Last line should be valid JSON
    assert.doesNotThrow(() => JSON.parse(lines[1]));
  });
});
