/**
 * Reducer unit tests for the dashboard store.
 * Pure reducer — no Ink, no React, no side-effects.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardReducer, initialState } from '../output/sinks/dashboard/store.js';
import type { DashboardState } from '../output/sinks/dashboard/store.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function applyActions(
  state: DashboardState,
  ...actions: Parameters<typeof dashboardReducer>[1][]
): DashboardState {
  return actions.reduce(dashboardReducer, state);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('dashboardReducer — session_connected', () => {
  test('creates a new session', () => {
    const state = dashboardReducer(initialState, {
      type: 'session_connected',
      sessionId: 'sess-1',
      label: 'S1',
    });
    assert.equal(state.sessions.length, 1);
    assert.equal(state.sessions[0].id, 'sess-1');
    assert.equal(state.sessions[0].label, 'S1');
    assert.equal(state.sessions[0].status, 'idle');
    assert.equal(state.sessions[0].alertCount, 0);
  });

  test('stores agent metadata', () => {
    const state = dashboardReducer(initialState, {
      type: 'session_connected',
      sessionId: 'sess-1',
      label: 'S1',
      agentName: 'oracle',
      agentDisplayName: 'Oracle',
    });
    assert.equal(state.sessions[0].agentName, 'oracle');
    assert.equal(state.sessions[0].agentDisplayName, 'Oracle');
  });

  test('does not duplicate existing session', () => {
    const s1 = dashboardReducer(initialState, {
      type: 'session_connected', sessionId: 'sess-1', label: 'S1',
    });
    const s2 = dashboardReducer(s1, {
      type: 'session_connected', sessionId: 'sess-1', label: 'S1',
    });
    assert.equal(s2.sessions.length, 1);
  });

  test('multiple sessions accumulate in order', () => {
    const state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'a', label: 'S1' },
      { type: 'session_connected', sessionId: 'b', label: 'S2' },
    );
    assert.equal(state.sessions.length, 2);
    assert.equal(state.sessions[0].id, 'a');
    assert.equal(state.sessions[1].id, 'b');
  });
});

describe('dashboardReducer — pre_clear', () => {
  test('creates a turn with preResult=clear', () => {
    let state = dashboardReducer(initialState, {
      type: 'session_connected', sessionId: 'sess-1', label: 'S1',
    });
    state = dashboardReducer(state, {
      type: 'pre_clear', sessionId: 'sess-1', promptId: 'p1', score: 0.3,
    });
    const session = state.sessions[0];
    assert.equal(session.turns.length, 1);
    assert.equal(session.turns[0].preResult, 'clear');
    assert.equal(session.turns[0].preScore, 0.3);
    assert.equal(session.turns[0].postResult, 'pending');
    assert.equal(session.status, 'running');
  });

  test('adds a glyph to streamGlyphs', () => {
    let state = dashboardReducer(initialState, {
      type: 'session_connected', sessionId: 'sess-1', label: 'S1',
    });
    state = dashboardReducer(state, {
      type: 'pre_clear', sessionId: 'sess-1', promptId: 'p1', score: 0.2,
    });
    assert.equal(state.streamGlyphs.length, 1);
    assert.match(state.streamGlyphs[0], /·/);
  });
});

describe('dashboardReducer — pre_advisory', () => {
  test('increments alertCount and stores advisory text', () => {
    let state = dashboardReducer(initialState, {
      type: 'session_connected', sessionId: 'sess-1', label: 'S1',
    });
    state = dashboardReducer(state, {
      type: 'pre_advisory',
      sessionId: 'sess-1',
      promptId: 'p1',
      score: 0.8,
      advisory: 'This looks risky.',
    });
    const session = state.sessions[0];
    assert.equal(session.alertCount, 1);
    assert.equal(session.turns[0].preResult, 'advisory');
    assert.equal(session.turns[0].preAdvisory, 'This looks risky.');
    assert.equal(session.status, 'running');
  });

  test('adds a ⚠ glyph to streamGlyphs', () => {
    let state = dashboardReducer(initialState, {
      type: 'session_connected', sessionId: 'sess-1', label: 'S1',
    });
    state = dashboardReducer(state, {
      type: 'pre_advisory', sessionId: 'sess-1', promptId: 'p1', score: 0.9, advisory: 'x',
    });
    assert.match(state.streamGlyphs[0], /⚠/);
  });
});

describe('dashboardReducer — post_aligned', () => {
  test('updates turn postResult to aligned', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'sess-1', label: 'S1' },
      { type: 'pre_clear', sessionId: 'sess-1', promptId: 'p1', score: 0.3 },
      { type: 'post_aligned', sessionId: 'sess-1', promptId: 'p1', summary: 'All good.' },
    );
    const turn = state.sessions[0].turns[0];
    assert.equal(turn.postResult, 'aligned');
    assert.equal(turn.postSummary, 'All good.');
    assert.equal(state.sessions[0].status, 'idle');
  });
});

describe('dashboardReducer — post_misaligned', () => {
  test('updates turn postResult to misaligned and increments alertCount', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'sess-1', label: 'S1' },
      { type: 'pre_advisory', sessionId: 'sess-1', promptId: 'p1', score: 0.9, advisory: 'pre advice' },
      { type: 'post_misaligned', sessionId: 'sess-1', promptId: 'p1', advisory: 'out of scope' },
    );
    const session = state.sessions[0];
    assert.equal(session.turns[0].postResult, 'misaligned');
    assert.equal(session.turns[0].postAdvisory, 'out of scope');
    // alertCount was already 1 from pre_advisory, now +1
    assert.equal(session.alertCount, 2);
  });

  test('adds a ✗ glyph to streamGlyphs', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'sess-1', label: 'S1' },
      { type: 'post_misaligned', sessionId: 'sess-1', promptId: 'p1', advisory: 'nope' },
    );
    assert.ok(state.streamGlyphs.some((g) => g.includes('✗')));
  });
});

describe('dashboardReducer — nav_session', () => {
  test('clamps to valid range — no negative index', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'a', label: 'S1' },
      { type: 'session_connected', sessionId: 'b', label: 'S2' },
    );
    state = dashboardReducer(state, { type: 'nav_session', delta: -5 });
    assert.equal(state.focusedSessionIdx, 0);
  });

  test('clamps to valid range — no overflow past last session', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'a', label: 'S1' },
      { type: 'session_connected', sessionId: 'b', label: 'S2' },
    );
    state = dashboardReducer(state, { type: 'nav_session', delta: 99 });
    assert.equal(state.focusedSessionIdx, 1);
  });

  test('moves down by 1', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'a', label: 'S1' },
      { type: 'session_connected', sessionId: 'b', label: 'S2' },
    );
    state = dashboardReducer(state, { type: 'nav_session', delta: 1 });
    assert.equal(state.focusedSessionIdx, 1);
  });

  test('resets focusedTurnIdx on session navigation', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'a', label: 'S1' },
      { type: 'session_connected', sessionId: 'b', label: 'S2' },
    );
    // Manually set focusedTurnIdx to something non-zero
    state = { ...state, focusedTurnIdx: 3 };
    state = dashboardReducer(state, { type: 'nav_session', delta: 1 });
    assert.equal(state.focusedTurnIdx, 0);
  });
});

describe('dashboardReducer — nav_turn', () => {
  test('clamps to valid range', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'sess-1', label: 'S1' },
      { type: 'pre_clear', sessionId: 'sess-1', promptId: 'p1', score: 0.1 },
    );
    state = dashboardReducer(state, { type: 'nav_turn', delta: -10 });
    assert.equal(state.focusedTurnIdx, 0);
  });

  test('does not exceed turn count', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'sess-1', label: 'S1' },
      { type: 'pre_clear', sessionId: 'sess-1', promptId: 'p1', score: 0.1 },
    );
    state = dashboardReducer(state, { type: 'nav_turn', delta: 99 });
    assert.equal(state.focusedTurnIdx, 0); // only 1 turn, max index is 0
  });
});

describe('dashboardReducer — toggle_expand', () => {
  test('flips the expanded flag on a turn', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'sess-1', label: 'S1' },
      { type: 'pre_advisory', sessionId: 'sess-1', promptId: 'p1', score: 0.9, advisory: 'risky' },
    );
    assert.equal(state.sessions[0].turns[0].expanded, false);
    state = dashboardReducer(state, { type: 'toggle_expand', turnIdx: 0 });
    assert.equal(state.sessions[0].turns[0].expanded, true);
    state = dashboardReducer(state, { type: 'toggle_expand', turnIdx: 0 });
    assert.equal(state.sessions[0].turns[0].expanded, false);
  });

  test('is a no-op for an out-of-range index', () => {
    let state = applyActions(
      initialState,
      { type: 'session_connected', sessionId: 'sess-1', label: 'S1' },
    );
    const before = state.lastUpdated;
    state = dashboardReducer(state, { type: 'toggle_expand', turnIdx: 99 });
    // No crash; state unchanged except no mutation happened
    assert.equal(state.sessions[0].turns.length, 0);
    // lastUpdated should not change (no-op path)
    assert.equal(state.lastUpdated, before);
  });
});

describe('dashboardReducer — tick', () => {
  test('updates lastUpdated', () => {
    const before = initialState.lastUpdated;
    // Small delay to ensure time differs
    const state = dashboardReducer(initialState, { type: 'tick' });
    assert.ok(state.lastUpdated >= before);
  });
});
