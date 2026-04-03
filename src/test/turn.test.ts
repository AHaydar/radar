import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TurnAggregator } from '../aggregator/turn.js';
import type { TurnContext, SessionSummary } from '../aggregator/turn.js';
import type { UserPromptEvent, ToolResultEvent, ApiRequestEvent, ApiErrorEvent, ToolDecisionEvent } from '../receiver/otlp.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makePromptEvent(promptId: string, prompt = 'fix the auth bug', sessionId = 'test-session-1'): UserPromptEvent {
  return {
    type: 'user_prompt',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    prompt,
    promptLength: prompt.length,
  };
}

function makeToolEvent(promptId: string, toolName = 'Edit', success = true, sessionId = 'test-session-1'): ToolResultEvent {
  return {
    type: 'tool_result',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    toolName,
    success,
    durationMs: 100,
  };
}

function makeBashEvent(promptId: string, command: string, sessionId = 'test-session-1'): ToolResultEvent {
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

function makeApiEvent(promptId: string, costUsd = 0.005, inputTokens = 300, outputTokens = 150, sessionId = 'test-session-1'): ApiRequestEvent {
  return {
    type: 'api_request',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    model: 'claude-sonnet-4-5',
    costUsd,
    inputTokens,
    outputTokens,
    durationMs: 2000,
  };
}

function makeErrorEvent(promptId: string, error = 'Rate limit', sessionId = 'test-session-1'): ApiErrorEvent {
  return {
    type: 'api_error',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    error,
    statusCode: 429,
  };
}

function makeToolDecisionEvent(promptId: string, toolName = 'Bash', decision = 'accept', source = 'config', sessionId = 'test-session-1'): ToolDecisionEvent {
  return {
    type: 'tool_decision',
    promptId,
    sessionId,
    timestampMs: Date.now(),
    toolName,
    decision,
    source,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TurnAggregator', () => {
  test('emits turn_start on first event for a promptId', async () => {
    const agg = new TurnAggregator();
    const started: TurnContext[] = [];
    agg.on('turn_start', (ctx: TurnContext) => started.push(ctx));

    agg.addEvent(makePromptEvent('p1'));

    assert.equal(started.length, 1);
    assert.equal(started[0].promptId, 'p1');
    assert.equal(started[0].prompt, 'fix the auth bug');
  });

  test('does not emit turn_start twice for same promptId', () => {
    const agg = new TurnAggregator();
    const started: TurnContext[] = [];
    agg.on('turn_start', (ctx: TurnContext) => started.push(ctx));

    agg.addEvent(makePromptEvent('p2'));
    agg.addEvent(makeToolEvent('p2'));
    agg.addEvent(makeApiEvent('p2'));

    assert.equal(started.length, 1, 'turn_start should only fire once per promptId');
  });

  test('accumulates tool results and api requests correctly', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p3'));
    agg.addEvent(makeToolEvent('p3', 'Edit'));
    agg.addEvent(makeToolEvent('p3', 'Read'));
    agg.addEvent(makeApiEvent('p3', 0.003, 200, 80));

    const ctx = agg.getContext('p3');
    assert.ok(ctx);
    assert.equal(ctx.toolResults.length, 2);
    assert.equal(ctx.toolResults[0].toolName, 'Edit');
    assert.equal(ctx.toolResults[1].toolName, 'Read');
    assert.equal(ctx.apiRequests.length, 1);
    assert.equal(ctx.apiRequests[0].costUsd, 0.003);
  });

  test('computes totalCostUsd and totalTokens correctly', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p4'));
    agg.addEvent(makeApiEvent('p4', 0.002, 100, 50));
    agg.addEvent(makeApiEvent('p4', 0.003, 200, 80));

    const ctx = agg.getContext('p4');
    assert.ok(ctx);
    assert.equal(ctx.totalCostUsd.toFixed(3), '0.005');
    assert.equal(ctx.totalInputTokens, 300);
    assert.equal(ctx.totalOutputTokens, 130);
  });

  test('computes unique toolNames', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p5'));
    agg.addEvent(makeToolEvent('p5', 'Edit'));
    agg.addEvent(makeToolEvent('p5', 'Edit'));
    agg.addEvent(makeToolEvent('p5', 'Read'));
    agg.addEvent(makeToolEvent('p5', 'Bash'));

    const ctx = agg.getContext('p5');
    assert.ok(ctx);
    assert.deepEqual([...ctx.toolNames].sort(), ['Bash', 'Edit', 'Read']);
  });

  test('extracts bash command from JSON toolParameters', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p6'));
    agg.addEvent(makeBashEvent('p6', 'npm test'));

    const ctx = agg.getContext('p6');
    assert.ok(ctx);
    assert.equal(ctx.toolResults[0].bashCommand, 'npm test');
  });

  test('accumulates errors', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p7'));
    agg.addEvent(makeErrorEvent('p7', 'Rate limit'));
    agg.addEvent(makeErrorEvent('p7', 'Timeout'));

    const ctx = agg.getContext('p7');
    assert.ok(ctx);
    assert.equal(ctx.errors.length, 2);
    assert.equal(ctx.errors[0], 'Rate limit');
    assert.equal(ctx.errors[1], 'Timeout');
  });

  test('keeps separate contexts for different promptIds', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('px', 'first prompt'));
    agg.addEvent(makePromptEvent('py', 'second prompt'));
    agg.addEvent(makeToolEvent('px', 'Edit'));
    agg.addEvent(makeToolEvent('py', 'Read'));

    const cx = agg.getContext('px');
    const cy = agg.getContext('py');
    assert.ok(cx);
    assert.ok(cy);
    assert.equal(cx.prompt, 'first prompt');
    assert.equal(cy.prompt, 'second prompt');
    assert.equal(cx.toolResults[0].toolName, 'Edit');
    assert.equal(cy.toolResults[0].toolName, 'Read');
  });

  test('emits turn_complete when completeTurn() is called', () => {
    const agg = new TurnAggregator();
    const completed: TurnContext[] = [];
    agg.on('turn_complete', (ctx: TurnContext) => completed.push(ctx));

    agg.addEvent(makePromptEvent('p8', 'fix the auth bug', 'sess-1'));
    agg.addEvent(makeToolEvent('p8', 'Edit', true, 'sess-1'));
    agg.addEvent(makeApiEvent('p8', 0.004, 250, 100, 'sess-1'));

    assert.equal(completed.length, 0, 'should not complete before completeTurn() is called');

    agg.completeTurn('sess-1');

    assert.equal(completed.length, 1);
    assert.equal(completed[0].promptId, 'p8');
    assert.equal(completed[0].toolResults.length, 1);
    assert.equal(completed[0].apiRequests.length, 1);
  });

  test('completeTurn() with no active turn is a no-op', () => {
    const agg = new TurnAggregator();
    const completed: TurnContext[] = [];
    agg.on('turn_complete', (ctx: TurnContext) => completed.push(ctx));

    // No events added — completeTurn should not crash or emit
    agg.completeTurn('sess-unknown');
    assert.equal(completed.length, 0);
  });

  test('completeTurn() cleans up context after completion', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p9', 'hello', 'sess-2'));
    assert.ok(agg.getContext('p9'), 'context should exist before completion');

    agg.completeTurn('sess-2');
    assert.equal(agg.getContext('p9'), undefined, 'context should be deleted after completion');
  });

  test('activeTurns tracks most recent turn per session', () => {
    const agg = new TurnAggregator();
    const completed: TurnContext[] = [];
    agg.on('turn_complete', (ctx: TurnContext) => completed.push(ctx));

    // Two turns for the same session in sequence
    agg.addEvent(makePromptEvent('p10a', 'first', 'sess-3'));
    agg.addEvent(makePromptEvent('p10b', 'second', 'sess-3'));

    // completeTurn should fire for the most recent one (p10b)
    agg.completeTurn('sess-3');
    assert.equal(completed.length, 1);
    assert.equal(completed[0].promptId, 'p10b');
  });

  test('accumulates toolDecisions', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p11'));
    agg.addEvent(makeToolDecisionEvent('p11', 'Bash', 'accept', 'config'));
    agg.addEvent(makeToolDecisionEvent('p11', 'Edit', 'reject', 'user'));

    const ctx = agg.getContext('p11');
    assert.ok(ctx);
    assert.equal(ctx.toolDecisions.length, 2);
    assert.equal(ctx.toolDecisions[0].toolName, 'Bash');
    assert.equal(ctx.toolDecisions[0].decision, 'accept');
    assert.equal(ctx.toolDecisions[1].toolName, 'Edit');
    assert.equal(ctx.toolDecisions[1].decision, 'reject');
    assert.equal(ctx.toolDecisions[1].source, 'user');
  });

  test('returns undefined for unknown promptId', () => {
    const agg = new TurnAggregator();
    assert.equal(agg.getContext('does-not-exist'), undefined);
  });

  test('scheduleCompletion() completes turn after delay when OTel arrived first', async () => {
    const agg = new TurnAggregator();
    const completed: TurnContext[] = [];
    agg.on('turn_complete', (ctx: TurnContext) => completed.push(ctx));

    agg.addEvent(makePromptEvent('p-sc1', 'fix bug', 'sess-sc1'));
    agg.addEvent(makeApiEvent('p-sc1', 0.002, 100, 50, 'sess-sc1'));

    // Shorten the delay to 10ms for the test
    (TurnAggregator as { COMPLETION_DELAY_MS: number }).COMPLETION_DELAY_MS = 10;
    agg.scheduleCompletion('sess-sc1');

    assert.equal(completed.length, 0, 'should not complete synchronously');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(completed.length, 1, 'should complete after delay');
    assert.equal(completed[0].promptId, 'p-sc1');
  });

  test('scheduleCompletion() still completes when stop fires before OTel events', async () => {
    const agg = new TurnAggregator();
    const completed: TurnContext[] = [];
    agg.on('turn_complete', (ctx: TurnContext) => completed.push(ctx));

    // Shorten the delay to 10ms for the test
    (TurnAggregator as { COMPLETION_DELAY_MS: number }).COMPLETION_DELAY_MS = 10;

    // Stop fires first — no OTel events yet
    agg.scheduleCompletion('sess-sc2');
    assert.equal(completed.length, 0);

    // OTel events arrive after the stop signal
    agg.addEvent(makePromptEvent('p-sc2', 'list files', 'sess-sc2'));
    agg.addEvent(makeApiEvent('p-sc2', 0.001, 80, 40, 'sess-sc2'));

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(completed.length, 1, 'should complete after OTel events arrive + delay');
    assert.equal(completed[0].promptId, 'p-sc2');
    assert.equal(completed[0].apiRequests.length, 1);
  });
});

describe('Session tracking', () => {
  test('emits session_start on first event from a new sessionId', () => {
    const agg = new TurnAggregator();
    const sessions: SessionSummary[] = [];
    agg.on('session_start', (s: SessionSummary) => sessions.push(s));

    agg.addEvent(makePromptEvent('p-a1', 'hello', 'sess-A'));
    agg.addEvent(makeToolEvent('p-a1', 'Edit', true, 'sess-A'));

    assert.equal(sessions.length, 1, 'session_start should fire once');
    assert.equal(sessions[0].label, 'S1');
    assert.equal(sessions[0].sessionId, 'sess-A');
    assert.equal(sessions[0].turnCount, 1);
  });

  test('assigns incrementing labels to different sessions', () => {
    const agg = new TurnAggregator();
    const sessions: SessionSummary[] = [];
    agg.on('session_start', (s: SessionSummary) => sessions.push(s));

    agg.addEvent(makePromptEvent('p-b1', 'hello', 'sess-A'));
    agg.addEvent(makePromptEvent('p-b2', 'world', 'sess-B'));

    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].label, 'S1');
    assert.equal(sessions[1].label, 'S2');
  });

  test('tracks turnCount correctly', () => {
    const agg = new TurnAggregator();
    agg.on('session_start', () => {});

    agg.addEvent(makePromptEvent('p-c1', 'first', 'sess-C'));
    agg.addEvent(makePromptEvent('p-c2', 'second', 'sess-C'));

    const session = agg.getSession('sess-C');
    assert.ok(session);
    assert.equal(session.turnCount, 2);
  });

  test('accumulates totalCostUsd on turn_complete', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p-d1', 'hello', 'sess-D'));
    agg.addEvent(makeApiEvent('p-d1', 0.007, 300, 100, 'sess-D'));

    agg.completeTurn('sess-D');

    const session = agg.getSession('sess-D');
    assert.ok(session);
    assert.ok(session.totalCostUsd > 0, 'totalCostUsd should be accumulated');
    assert.equal(session.completedTurns, 1);
  });

  test('getSessions() returns all tracked sessions', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p-e1', 'hello', 'sess-E1'));
    agg.addEvent(makePromptEvent('p-e2', 'world', 'sess-E2'));

    const all = agg.getSessions();
    assert.equal(all.length, 2);
    const ids = all.map((s) => s.sessionId).sort();
    assert.deepEqual(ids, ['sess-E1', 'sess-E2']);
  });

  test('getSession() returns a specific session by ID', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p-f1', 'hello', 'sess-F'));

    const session = agg.getSession('sess-F');
    assert.ok(session);
    assert.equal(session.sessionId, 'sess-F');
    assert.equal(session.label, 'S1');

    assert.equal(agg.getSession('unknown-session'), undefined);
  });

  test('TurnContext includes sessionId', () => {
    const agg = new TurnAggregator();

    agg.addEvent(makePromptEvent('p-g1', 'hello', 'sess-G'));

    const ctx = agg.getContext('p-g1');
    assert.ok(ctx);
    assert.equal(ctx.sessionId, 'sess-G');
  });
});
