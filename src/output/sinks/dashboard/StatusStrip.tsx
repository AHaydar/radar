import React from 'react';
import { Box, Text, Static } from 'ink';

interface Props {
  glyphs: string[];
}

// Hint line shown at the bottom
const HINT = '↑/↓ session · ←/→ turn · enter expand · c copy · q exit';

export function StatusStrip({ glyphs }: Props): React.ReactElement {
  return (
    <Box flexDirection="column">
      <Box paddingX={1} flexWrap="wrap">
        {glyphs.length === 0 ? (
          <Text dimColor>No events yet.</Text>
        ) : (
          <Text>{glyphs.join(' ')}</Text>
        )}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{HINT}</Text>
      </Box>
    </Box>
  );
}
