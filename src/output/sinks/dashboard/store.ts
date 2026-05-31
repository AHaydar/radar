/**
 * Dashboard store — state shape and useReducer actions.
 * Pure reducer, no side-effects, no Ink imports.
 */

export interface Turn {
  promptId: string;
  ts: number;
  preScore?: number;
  preResult: 'clear' | 'advisory' | null;
  preAdvisory?: string;
  postResult: 'aligned' | 'misaligned' | 'pending' | null;
  postAdvisory?: string;
  postSummary?: string;
  expanded: boolean;
}

export interface Session {
  id: string;
  label: string;           // S1, S2, …
  agentName?: string;      // 'oracle'
  agentDisplayName?: string; // 'Oracle'
  status: 'running' | 'idle';
  lastEventAt?: number;    // unix ms
  alertCount: number;
  turns: Turn[];           // last N turns, most recent first
}

export interface DashboardState {
  sessions: Session[];          // ordered by first-seen
  focusedSessionIdx: number;    // which session row has focus
  focusedTurnIdx: number;       // which turn in the detail panel has focus
  streamGlyphs: string[];       // growing list of event glyphs for the Stream strip
  lastUpdated: number;          // unix ms — used to drive clock tick
}

// ── Actions ─────────────────────────────────────────────────────────────────

export type Action =
  | { type: 'session_connected'; sessionId: string; label: string; agentName?: string; agentDisplayName?: string }
  | { type: 'pre_clear'; sessionId: string; promptId: string; score: number }
  | { type: 'pre_advisory'; sessionId: string; promptId: string; score: number; advisory: string }
  | { type: 'post_aligned'; sessionId: string; promptId: string; summary: string }
  | { type: 'post_misaligned'; sessionId: string; promptId: string; advisory: string }
  | { type: 'session_status'; sessionId: string; status: 'running' | 'idle' }
  | { type: 'toggle_expand'; turnIdx: number }
  | { type: 'nav_session'; delta: number }
  | { type: 'nav_turn'; delta: number }
  | { type: 'tick' };

// ── Helpers ──────────────────────────────────────────────────────────────────

const MAX_TURNS = 20;
const MAX_GLYPHS = 60;

function getSessionIndex(state: DashboardState, sessionId: string): number {
  return state.sessions.findIndex((s) => s.id === sessionId);
}

function ensureSession(state: DashboardState, sessionId: string): DashboardState {
  if (getSessionIndex(state, sessionId) !== -1) return state;
  const newSession: Session = {
    id: sessionId,
    label: `S${state.sessions.length + 1}`,
    status: 'idle',
    alertCount: 0,
    turns: [],
  };
  return { ...state, sessions: [...state.sessions, newSession] };
}

function getActiveTurn(session: Session): Turn | undefined {
  // Most recent turn (index 0) that has no postResult
  return session.turns.find((t) => t.postResult === 'pending' || t.postResult === null);
}

function upsertTurn(session: Session, promptId: string, update: Partial<Turn>): Session {
  const existing = session.turns.findIndex((t) => t.promptId === promptId);
  if (existing !== -1) {
    const updated = [...session.turns];
    updated[existing] = { ...updated[existing], ...update };
    return { ...session, turns: updated };
  }
  // New turn — prepend to front
  const newTurn: Turn = {
    promptId,
    ts: Date.now(),
    preResult: null,
    postResult: 'pending',
    expanded: false,
    ...update,
  };
  const turns = [newTurn, ...session.turns].slice(0, MAX_TURNS);
  return { ...session, turns };
}

// ── Reducer ──────────────────────────────────────────────────────────────────

export function dashboardReducer(state: DashboardState, action: Action): DashboardState {
  switch (action.type) {
    case 'session_connected': {
      const exists = getSessionIndex(state, action.sessionId) !== -1;
      if (exists) {
        // Update agent metadata if provided
        const sessions = state.sessions.map((s) =>
          s.id === action.sessionId
            ? {
                ...s,
                agentName: action.agentName ?? s.agentName,
                agentDisplayName: action.agentDisplayName ?? s.agentDisplayName,
              }
            : s,
        );
        return { ...state, sessions, lastUpdated: Date.now() };
      }
      const newSession: Session = {
        id: action.sessionId,
        label: action.label,
        agentName: action.agentName,
        agentDisplayName: action.agentDisplayName,
        status: 'idle',
        alertCount: 0,
        turns: [],
      };
      return {
        ...state,
        sessions: [...state.sessions, newSession],
        lastUpdated: Date.now(),
      };
    }

    case 'pre_clear': {
      const s = ensureSession(state, action.sessionId);
      const idx = getSessionIndex(s, action.sessionId);
      const session = upsertTurn(s.sessions[idx], action.promptId, {
        preResult: 'clear',
        preScore: action.score,
        postResult: 'pending',
      });
      const glyph = (session.agentDisplayName ?? session.label).charAt(0) + '·';
      const sessions = [...s.sessions];
      sessions[idx] = { ...session, status: 'running', lastEventAt: Date.now() };
      return {
        ...s,
        sessions,
        streamGlyphs: [...s.streamGlyphs, glyph].slice(-MAX_GLYPHS),
        lastUpdated: Date.now(),
      };
    }

    case 'pre_advisory': {
      const s = ensureSession(state, action.sessionId);
      const idx = getSessionIndex(s, action.sessionId);
      const session = upsertTurn(s.sessions[idx], action.promptId, {
        preResult: 'advisory',
        preScore: action.score,
        preAdvisory: action.advisory,
        postResult: 'pending',
      });
      const glyph = (session.agentDisplayName ?? session.label).charAt(0) + '⚠';
      const sessions = [...s.sessions];
      sessions[idx] = {
        ...session,
        status: 'running',
        lastEventAt: Date.now(),
        alertCount: s.sessions[idx].alertCount + 1,
      };
      return {
        ...s,
        sessions,
        streamGlyphs: [...s.streamGlyphs, glyph].slice(-MAX_GLYPHS),
        lastUpdated: Date.now(),
      };
    }

    case 'post_aligned': {
      const s = ensureSession(state, action.sessionId);
      const idx = getSessionIndex(s, action.sessionId);
      const session = upsertTurn(s.sessions[idx], action.promptId, {
        postResult: 'aligned',
        postSummary: action.summary,
      });
      const glyph = (session.agentDisplayName ?? session.label).charAt(0) + '✓';
      const sessions = [...s.sessions];
      sessions[idx] = { ...session, status: 'idle', lastEventAt: Date.now() };
      return {
        ...s,
        sessions,
        streamGlyphs: [...s.streamGlyphs, glyph].slice(-MAX_GLYPHS),
        lastUpdated: Date.now(),
      };
    }

    case 'post_misaligned': {
      const s = ensureSession(state, action.sessionId);
      const idx = getSessionIndex(s, action.sessionId);
      const session = upsertTurn(s.sessions[idx], action.promptId, {
        postResult: 'misaligned',
        postAdvisory: action.advisory,
      });
      const glyph = (session.agentDisplayName ?? session.label).charAt(0) + '✗';
      const sessions = [...s.sessions];
      sessions[idx] = {
        ...session,
        status: 'idle',
        lastEventAt: Date.now(),
        alertCount: s.sessions[idx].alertCount + 1,
      };
      return {
        ...s,
        sessions,
        streamGlyphs: [...s.streamGlyphs, glyph].slice(-MAX_GLYPHS),
        lastUpdated: Date.now(),
      };
    }

    case 'session_status': {
      const idx = getSessionIndex(state, action.sessionId);
      if (idx === -1) return state;
      const sessions = [...state.sessions];
      sessions[idx] = { ...sessions[idx], status: action.status };
      return { ...state, sessions, lastUpdated: Date.now() };
    }

    case 'toggle_expand': {
      const focused = state.sessions[state.focusedSessionIdx];
      if (!focused) return state;
      const idx = action.turnIdx;
      if (idx < 0 || idx >= focused.turns.length) return state;
      const turns = [...focused.turns];
      turns[idx] = { ...turns[idx], expanded: !turns[idx].expanded };
      const sessions = [...state.sessions];
      sessions[state.focusedSessionIdx] = { ...focused, turns };
      return { ...state, sessions, lastUpdated: Date.now() };
    }

    case 'nav_session': {
      const max = state.sessions.length - 1;
      if (max < 0) return state;
      const next = Math.max(0, Math.min(max, state.focusedSessionIdx + action.delta));
      return { ...state, focusedSessionIdx: next, focusedTurnIdx: 0, lastUpdated: Date.now() };
    }

    case 'nav_turn': {
      const focused = state.sessions[state.focusedSessionIdx];
      if (!focused || focused.turns.length === 0) return state;
      const max = focused.turns.length - 1;
      const next = Math.max(0, Math.min(max, state.focusedTurnIdx + action.delta));
      return { ...state, focusedTurnIdx: next, lastUpdated: Date.now() };
    }

    case 'tick': {
      return { ...state, lastUpdated: Date.now() };
    }

    default:
      return state;
  }
}

export const initialState: DashboardState = {
  sessions: [],
  focusedSessionIdx: 0,
  focusedTurnIdx: 0,
  streamGlyphs: [],
  lastUpdated: Date.now(),
};
