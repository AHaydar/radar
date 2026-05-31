/**
 * Agent color binding — hash agentName to a consistent Ink color.
 * Fallback to index-based color for unnamed sessions.
 */

const AGENT_COLORS = ['cyan', 'magenta', 'green', 'yellow', 'blue', 'white'] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

export function agentColor(agentName: string | undefined, labelIndex: number): AgentColor {
  if (!agentName) return AGENT_COLORS[labelIndex % AGENT_COLORS.length];
  // djb2-style hash
  let h = 5381;
  for (let i = 0; i < agentName.length; i++) {
    h = ((h << 5) + h) + agentName.charCodeAt(i);
    h = h | 0; // force 32-bit int
  }
  return AGENT_COLORS[Math.abs(h) % AGENT_COLORS.length];
}
