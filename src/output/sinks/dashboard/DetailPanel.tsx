import React from 'react';
import { Box, Text } from 'ink';
import { execSync } from 'node:child_process';
import type { Session, Turn } from './store.js';

interface Props {
  session: Session | undefined;
  focusedTurnIdx: number;
  copyWarning: string | null;
}

function turnTime(ts: number): string {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function preGlyph(turn: Turn): { glyph: string; color: string } {
  if (turn.preResult === 'advisory') return { glyph: '⚠', color: 'yellow' };
  if (turn.preResult === 'clear') return { glyph: '✓', color: 'green' };
  return { glyph: '·', color: 'gray' };
}

function postGlyph(turn: Turn): { glyph: string; color: string } {
  if (turn.postResult === 'misaligned') return { glyph: '✗', color: 'red' };
  if (turn.postResult === 'aligned') return { glyph: '✓', color: 'green' };
  if (turn.postResult === 'error') return { glyph: '?', color: 'yellow' };
  if (turn.postResult === 'pending') return { glyph: '…', color: 'cyan' };
  return { glyph: '·', color: 'gray' };
}

export function copyToClipboard(text: string): string | null {
  try {
    if (process.platform === 'darwin') {
      execSync('pbcopy', { input: text });
    } else {
      execSync('xclip -selection clipboard', { input: text });
    }
    return null;
  } catch {
    return 'Could not copy: pbcopy/xclip not available';
  }
}

export function DetailPanel({ session, focusedTurnIdx, copyWarning }: Props): React.ReactElement {
  if (!session) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No session selected.</Text>
      </Box>
    );
  }

  if (session.turns.length === 0) {
    return (
      <Box paddingX={1}>
        <Text dimColor>No turns yet.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {copyWarning && (
        <Box paddingX={1}>
          <Text color="yellow">{copyWarning}</Text>
        </Box>
      )}
      {session.turns.map((turn, i) => {
        const focused = i === focusedTurnIdx;
        const pre = preGlyph(turn);
        const post = postGlyph(turn);
        const time = turnTime(turn.ts);

        return (
          <Box key={turn.promptId} flexDirection="column" paddingX={1}>
            <Box>
              <Text color={focused ? 'white' : 'gray'}>{focused ? '> ' : '  '}</Text>
              <Text dimColor>{time + ' '}</Text>
              <Text color={turn.preResult !== null ? pre.color : 'gray'}>
                {'PRE ' + pre.glyph + ' '}
              </Text>
              <Text color={turn.postResult !== null ? post.color : 'gray'}>
                {'POST ' + post.glyph + ' '}
              </Text>
              {turn.preResult === 'advisory' && turn.preAdvisory && (
                <Text color="yellow" dimColor={!focused}>
                  {(turn.preAdvisory.length > 50 && !turn.expanded)
                    ? turn.preAdvisory.slice(0, 50) + '…'
                    : turn.preAdvisory}
                </Text>
              )}
              {turn.postResult === 'aligned' && turn.postSummary && (
                <Text color="green" dimColor={!focused}>
                  {(turn.postSummary.length > 50 && !turn.expanded)
                    ? turn.postSummary.slice(0, 50) + '…'
                    : turn.postSummary}
                </Text>
              )}
            </Box>
            {turn.expanded && turn.postResult === 'misaligned' && turn.postAdvisory && (
              <Box paddingLeft={4}>
                <Text color="red">{'↳ '}{turn.postAdvisory}</Text>
              </Box>
            )}
            {turn.expanded && turn.preResult === 'advisory' && turn.preAdvisory && (
              <Box paddingLeft={4}>
                <Text color="yellow">{'↳ '}{turn.preAdvisory}</Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
