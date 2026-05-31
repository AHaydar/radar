import React from 'react';
import { Box, Text } from 'ink';
import type { Session } from './store.js';
import { agentColor } from './colors.js';

interface Props {
  sessions: Session[];
  focusedIdx: number;
}

function statusGlyph(session: Session): string {
  if (session.status === 'running') return '●';
  const lastTurn = session.turns[0];
  if (!lastTurn) return '●';
  if (lastTurn.postResult === 'misaligned') return '✗';
  if (lastTurn.preResult === 'advisory') return '⚠';
  if (lastTurn.postResult === 'aligned') return '✓';
  return '●';
}

function statusLabel(session: Session): string {
  if (session.status === 'running') return 'running…';
  const lastTurn = session.turns[0];
  if (!lastTurn) return 'idle';
  if (lastTurn.postResult === 'misaligned') return 'misaligned';
  if (lastTurn.preResult === 'advisory') return 'advisory';
  if (lastTurn.postResult === 'aligned') return 'aligned';
  return 'idle';
}

function statusColor(session: Session): string {
  if (session.status === 'running') return 'cyan';
  const lastTurn = session.turns[0];
  if (!lastTurn) return 'gray';
  if (lastTurn.postResult === 'misaligned') return 'red';
  if (lastTurn.preResult === 'advisory') return 'yellow';
  if (lastTurn.postResult === 'aligned') return 'green';
  return 'gray';
}

function formatTime(ts: number | undefined): string {
  if (!ts) return '     ';
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

export function SessionTable({ sessions, focusedIdx }: Props): React.ReactElement {
  if (sessions.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>Waiting for sessions…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {sessions.map((session, i) => {
        const focused = i === focusedIdx;
        const name = session.agentDisplayName ?? session.label;
        const color = agentColor(session.agentName, i);
        const glyph = statusGlyph(session);
        const label = statusLabel(session);
        const sColor = statusColor(session);
        const time = formatTime(session.lastEventAt);

        return (
          <Box key={session.id} paddingX={1}>
            <Text color={focused ? 'white' : 'gray'}>{focused ? '> ' : '  '}</Text>
            <Text color={color} bold={focused}>{name.padEnd(10)}</Text>
            <Text color={sColor}>{glyph + ' '}</Text>
            <Text color={sColor}>{label.padEnd(12)}</Text>
            <Text dimColor>{time + '  '}</Text>
            {session.alertCount > 0 ? (
              <Text color="yellow">{session.alertCount} ⚠</Text>
            ) : (
              <Text dimColor>{'  '}</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
