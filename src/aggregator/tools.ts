import type { ToolResultSummary } from './turn.js';

/**
 * Build a human-readable summary of tool usage from a list of tool results.
 * Groups Bash calls by command; de-duplicates other tools with counts.
 */
export function buildToolSummary(toolResults: ToolResultSummary[]): string {
  const parts: string[] = [];

  // Group tool calls by name, tracking Bash separately
  const toolCounts = new Map<string, number>();
  const bashCommands: string[] = [];
  let bashCallCount = 0;

  for (const result of toolResults) {
    if (result.toolName === 'Bash') {
      bashCallCount++;
      if (result.bashCommand) {
        bashCommands.push(`'${result.bashCommand}'`);
      }
    } else {
      toolCounts.set(result.toolName, (toolCounts.get(result.toolName) ?? 0) + 1);
    }
  }

  // Add non-bash tools
  for (const [toolName, count] of toolCounts.entries()) {
    parts.push(count === 1 ? toolName : `${toolName} (${count} calls)`);
  }

  // Add bash summary
  if (bashCallCount > 0) {
    if (bashCommands.length > 0) {
      const bashLabel =
        bashCommands.length <= 3
          ? `Bash: ${bashCommands.join(', ')}`
          : `Bash: ${bashCommands.slice(0, 3).join(', ')} +${bashCommands.length - 3} more`;
      parts.push(bashLabel);
    } else {
      parts.push(`Bash (${bashCallCount} calls)`);
    }
  }

  return parts.join(' · ') || 'No tools used';
}
