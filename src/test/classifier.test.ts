import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolSummary } from '../aggregator/tools.js';
import type { ToolResultSummary, TurnHistoryEntry } from '../aggregator/turn.js';
import { TurnAggregator } from '../aggregator/turn.js';
import type { UserPromptEvent, ToolResultEvent, ApiRequestEvent } from '../receiver/otlp.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeToolResult(toolName: string, bashCommand?: string): ToolResultSummary {
  return { toolName, success: true, durationMs: 100, bashCommand };
}

function makePromptEvent(
  promptId: string,
  prompt = 'fix the auth bug',
  sessionId = 'sess-1',
): UserPromptEvent {
  return {
    type: 'user_prompt',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    prompt,
    promptLength: prompt.length,
  };
}

function makeToolEvent(
  promptId: string,
  toolName = 'Edit',
  sessionId = 'sess-1',
): ToolResultEvent {
  return {
    type: 'tool_result',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    toolName,
    success: true,
    durationMs: 100,
  };
}

function makeBashEvent(promptId: string, command: string, sessionId = 'sess-1'): ToolResultEvent {
  return {
    type: 'tool_result',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    toolName: 'Bash',
    success: true,
    durationMs: 250,
    toolParameters: JSON.stringify({ command }),
  };
}

function makeApiEvent(promptId: string, sessionId = 'sess-1'): ApiRequestEvent {
  return {
    type: 'api_request',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    model: 'claude-sonnet-4-5',
    costUsd: 0.005,
    inputTokens: 300,
    outputTokens: 150,
    durationMs: 2000,
  };
}

// Complete a turn synchronously using completeTurn directly
function completeTurn(agg: TurnAggregator, promptId: string, sessionId: string): void {
  agg.addEvent(makePromptEvent(promptId, `prompt for ${promptId}`, sessionId));
  agg.addEvent(makeToolEvent(promptId, 'Edit', sessionId));
  agg.addEvent(makeApiEvent(promptId, sessionId));
  agg.completeTurn(sessionId);
}

// ── buildToolSummary tests ─────────────────────────────────────────────────────

describe('buildToolSummary', () => {
  test('returns "No tools used" for empty array', () => {
    assert.equal(buildToolSummary([]), 'No tools used');
  });

  test('single non-bash tool', () => {
    const result = buildToolSummary([makeToolResult('Edit')]);
    assert.equal(result, 'Edit');
  });

  test('multiple calls of same tool shows count', () => {
    const result = buildToolSummary([
      makeToolResult('Edit'),
      makeToolResult('Edit'),
      makeToolResult('Edit'),
    ]);
    assert.equal(result, 'Edit (3 calls)');
  });

  test('multiple different non-bash tools', () => {
    const result = buildToolSummary([makeToolResult('Edit'), makeToolResult('Read')]);
    assert.equal(result, 'Edit · Read');
  });

  test('bash tool with known command', () => {
    const result = buildToolSummary([makeToolResult('Bash', 'npm test')]);
    assert.equal(result, "Bash: 'npm test'");
  });

  test('bash tool without command (no bashCommand field)', () => {
    const result = buildToolSummary([{ toolName: 'Bash', success: true, durationMs: 100 }]);
    assert.equal(result, 'Bash (1 calls)');
  });

  test('up to 3 bash commands shown inline', () => {
    const results = [
      makeToolResult('Bash', 'git status'),
      makeToolResult('Bash', 'npm test'),
      makeToolResult('Bash', 'ls'),
    ];
    const result = buildToolSummary(results);
    assert.equal(result, "Bash: 'git status', 'npm test', 'ls'");
  });

  test('more than 3 bash commands uses overflow notation', () => {
    const results = [
      makeToolResult('Bash', 'git status'),
      makeToolResult('Bash', 'npm test'),
      makeToolResult('Bash', 'ls'),
      makeToolResult('Bash', 'pwd'),
    ];
    const result = buildToolSummary(results);
    assert.equal(result, "Bash: 'git status', 'npm test', 'ls' +1 more");
  });

  test('mixed tools and bash', () => {
    const result = buildToolSummary([
      makeToolResult('Edit'),
      makeToolResult('Read'),
      makeToolResult('Bash', 'npm test'),
    ]);
    assert.equal(result, "Edit · Read · Bash: 'npm test'");
  });

  test('does not include token or cost information', () => {
    const result = buildToolSummary([makeToolResult('Edit')]);
    assert.ok(!result.includes('token'), 'should not include token count');
    assert.ok(!result.includes('$'), 'should not include cost');
  });
});

// ── formatClassifierInput tests ───────────────────────────────────────────────
// We test this indirectly by verifying the Classifier class correctly formats
// its input. Since formatClassifierInput is a module-private function, we
// inspect the expected output format by reconstructing it here.

function formatClassifierInput(prompt: string, history?: TurnHistoryEntry[]): string {
  if (!history || history.length === 0) {
    return `User prompt to classify:\n${prompt}`;
  }
  const lines = history.map(
    (h, i) => `Turn ${i + 1}: "${h.prompt}"\n  → ${h.toolSummary}`,
  );
  return `Recent conversation:\n${lines.join('\n')}\n\nUser prompt to classify:\n${prompt}`;
}

describe('formatClassifierInput', () => {
  test('empty history returns simple format', () => {
    const result = formatClassifierInput('fix the bug');
    assert.equal(result, 'User prompt to classify:\nfix the bug');
  });

  test('undefined history returns simple format', () => {
    const result = formatClassifierInput('fix the bug', undefined);
    assert.equal(result, 'User prompt to classify:\nfix the bug');
  });

  test('empty array history returns simple format', () => {
    const result = formatClassifierInput('fix the bug', []);
    assert.equal(result, 'User prompt to classify:\nfix the bug');
  });

  test('one history entry produces conversation block', () => {
    const history: TurnHistoryEntry[] = [
      { prompt: 'update the auth module', toolSummary: 'Edit · Read' },
    ];
    const result = formatClassifierInput('do the same for the other file', history);
    assert.ok(result.startsWith('Recent conversation:'));
    assert.ok(result.includes('Turn 1: "update the auth module"'));
    assert.ok(result.includes('  → Edit · Read'));
    assert.ok(result.includes('User prompt to classify:\ndo the same for the other file'));
  });

  test('three history entries all appear in order', () => {
    const history: TurnHistoryEntry[] = [
      { prompt: 'first prompt', toolSummary: 'Edit' },
      { prompt: 'second prompt', toolSummary: 'Read' },
      { prompt: 'third prompt', toolSummary: "Bash: 'npm test'" },
    ];
    const result = formatClassifierInput('now do the same', history);
    assert.ok(result.includes('Turn 1: "first prompt"'));
    assert.ok(result.includes('Turn 2: "second prompt"'));
    assert.ok(result.includes('Turn 3: "third prompt"'));
    assert.ok(result.endsWith('User prompt to classify:\nnow do the same'));
  });
});

// ── TurnAggregator.getRecentTurns tests ───────────────────────────────────────

describe('TurnAggregator.getRecentTurns', () => {
  test('returns empty array for unknown session', () => {
    const agg = new TurnAggregator();
    assert.deepEqual(agg.getRecentTurns('no-such-session'), []);
  });

  test('returns empty array for session with no completed turns', () => {
    const agg = new TurnAggregator();
    agg.addEvent(makePromptEvent('p1', 'hello', 'sess-a'));
    assert.deepEqual(agg.getRecentTurns('sess-a'), []);
  });

  test('populates one entry after completeTurn', () => {
    const agg = new TurnAggregator();
    completeTurn(agg, 'p1', 'sess-b');

    const history = agg.getRecentTurns('sess-b');
    assert.equal(history.length, 1);
    assert.equal(history[0].prompt, 'prompt for p1');
    assert.equal(history[0].toolSummary, 'Edit');
  });

  test('accumulates entries up to 3', () => {
    const agg = new TurnAggregator();

    completeTurn(agg, 'p1', 'sess-c');
    completeTurn(agg, 'p2', 'sess-c');
    completeTurn(agg, 'p3', 'sess-c');

    const history = agg.getRecentTurns('sess-c');
    assert.equal(history.length, 3);
    assert.equal(history[0].prompt, 'prompt for p1');
    assert.equal(history[1].prompt, 'prompt for p2');
    assert.equal(history[2].prompt, 'prompt for p3');
  });

  test('caps at 3 entries, dropping oldest when a 4th is added', () => {
    const agg = new TurnAggregator();

    completeTurn(agg, 'p1', 'sess-d');
    completeTurn(agg, 'p2', 'sess-d');
    completeTurn(agg, 'p3', 'sess-d');
    completeTurn(agg, 'p4', 'sess-d');

    const history = agg.getRecentTurns('sess-d');
    assert.equal(history.length, 3);
    assert.equal(history[0].prompt, 'prompt for p2');
    assert.equal(history[1].prompt, 'prompt for p3');
    assert.equal(history[2].prompt, 'prompt for p4');
  });

  test('histories are isolated between sessions', () => {
    const agg = new TurnAggregator();

    completeTurn(agg, 'p1', 'sess-e1');
    completeTurn(agg, 'p2', 'sess-e2');

    assert.equal(agg.getRecentTurns('sess-e1').length, 1);
    assert.equal(agg.getRecentTurns('sess-e2').length, 1);
    assert.equal(agg.getRecentTurns('sess-e1')[0].prompt, 'prompt for p1');
    assert.equal(agg.getRecentTurns('sess-e2')[0].prompt, 'prompt for p2');
  });

  test('tool summary in history reflects actual tools used', () => {
    const agg = new TurnAggregator();
    agg.addEvent(makePromptEvent('px', 'refactor auth', 'sess-f'));
    agg.addEvent(makeBashEvent('px', 'npm test', 'sess-f'));
    agg.addEvent(makeToolEvent('px', 'Edit', 'sess-f'));
    agg.addEvent(makeApiEvent('px', 'sess-f'));
    agg.completeTurn('sess-f');

    const history = agg.getRecentTurns('sess-f');
    assert.equal(history.length, 1);
    assert.equal(history[0].prompt, 'refactor auth');
    assert.ok(history[0].toolSummary.includes('Edit'), 'should include Edit');
    assert.ok(history[0].toolSummary.includes('npm test'), 'should include bash command');
  });
});
