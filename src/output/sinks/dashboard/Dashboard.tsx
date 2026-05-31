import React, { useReducer, useEffect, useState, useCallback } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { dashboardReducer, initialState } from './store.js';
import type { Action } from './store.js';
import { SessionTable } from './SessionTable.js';
import { DetailPanel, copyToClipboard } from './DetailPanel.js';
import { StatusStrip } from './StatusStrip.js';

// Version — read from package.json at build time via the module path
const RADAR_VERSION = '0.1.5';

interface Props {
  onDispatchReady?: (dispatch: (action: Action) => void) => void;
  onExit?: () => void;
}

function formatClock(date: Date): string {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

export function Dashboard({ onDispatchReady, onExit }: Props): React.ReactElement {
  const [state, dispatch] = useReducer(dashboardReducer, initialState);
  const [clock, setClock] = useState(() => formatClock(new Date()));
  const [copyWarning, setCopyWarning] = useState<string | null>(null);
  const { exit } = useApp();

  // Expose dispatch to the DashboardSink class
  useEffect(() => {
    onDispatchReady?.(dispatch);
  }, [onDispatchReady, dispatch]);

  // Clock tick — every second
  useEffect(() => {
    const timer = setInterval(() => {
      setClock(formatClock(new Date()));
      dispatch({ type: 'tick' });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Clear copy warning after 3s
  useEffect(() => {
    if (copyWarning) {
      const t = setTimeout(() => setCopyWarning(null), 3000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [copyWarning]);

  const handleExit = useCallback(() => {
    onExit?.();
    exit();
  }, [onExit, exit]);

  useInput((input, key) => {
    if (input === 'q' || input === '\x07') {
      handleExit();
      return;
    }
    if (key.upArrow) {
      dispatch({ type: 'nav_session', delta: -1 });
      return;
    }
    if (key.downArrow) {
      dispatch({ type: 'nav_session', delta: 1 });
      return;
    }
    if (key.leftArrow) {
      dispatch({ type: 'nav_turn', delta: -1 });
      return;
    }
    if (key.rightArrow) {
      dispatch({ type: 'nav_turn', delta: 1 });
      return;
    }
    if (key.return) {
      dispatch({ type: 'toggle_expand', turnIdx: state.focusedTurnIdx });
      return;
    }
    if (input === 'c') {
      const session = state.sessions[state.focusedSessionIdx];
      const turn = session?.turns[state.focusedTurnIdx];
      const text = turn?.postAdvisory ?? turn?.preAdvisory ?? '';
      if (text) {
        const warning = copyToClipboard(text);
        setCopyWarning(warning);
      }
      return;
    }
    // Jump to session by number (1-9)
    const num = parseInt(input, 10);
    if (!isNaN(num) && num >= 1 && num <= 9) {
      const targetIdx = num - 1;
      const delta = targetIdx - state.focusedSessionIdx;
      if (delta !== 0) dispatch({ type: 'nav_session', delta });
    }
  });

  const focusedSession = state.sessions[state.focusedSessionIdx];
  const panelTitle = focusedSession
    ? `${focusedSession.agentDisplayName ?? focusedSession.label} — last ${focusedSession.turns.length} turns`
    : 'No session';

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray">
      {/* Header */}
      <Box paddingX={1} justifyContent="space-between">
        <Text bold>Radar v{RADAR_VERSION}</Text>
        <Text dimColor>{clock}</Text>
      </Box>

      {/* Session table */}
      <Box flexDirection="column">
        <SessionTable
          sessions={state.sessions}
          focusedIdx={state.focusedSessionIdx}
        />
      </Box>

      {/* Detail panel separator */}
      <Box paddingX={1}>
        <Text dimColor>{'─ '}{panelTitle}{' ─── [←/→ scroll turns]'}</Text>
      </Box>

      {/* Detail panel */}
      <Box flexDirection="column">
        <DetailPanel
          session={focusedSession}
          focusedTurnIdx={state.focusedTurnIdx}
          copyWarning={copyWarning}
        />
      </Box>

      {/* Stream strip separator */}
      <Box paddingX={1}>
        <Text dimColor>{'─ Stream '}{'─'.repeat(30)}</Text>
      </Box>

      {/* Status strip + hint line */}
      <StatusStrip glyphs={state.streamGlyphs} />
    </Box>
  );
}
