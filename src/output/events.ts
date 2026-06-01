/** Optional agent metadata — available when launcher scripts export CLAUDE_AGENT_NAME etc. */
export interface AgentMeta {
  name: string;        // 'oracle'
  displayName: string; // 'Oracle'
  role?: string;       // 'Architect'
}

/**
 * RadarEvent — typed discriminated union for all observable events in the
 * watch pipeline. Each variant maps 1-to-1 to a print* function in formatter.ts;
 * sinks decide how (and whether) to render each variant.
 */
export type RadarEvent =
  | { type: 'banner'; port: number }
  | { type: 'session.connected'; label: string; sessionId: string; agent?: AgentMeta }
  | { type: 'pre.clear'; label?: string; score: number; agent?: AgentMeta }
  | { type: 'pre.advisory'; label?: string; score: number; advisory: string; agent?: AgentMeta }
  | { type: 'post.aligned'; label?: string; score?: number; summary: string; agent?: AgentMeta }
  | { type: 'post.misaligned'; label?: string; advisory: string; agent?: AgentMeta }
  | { type: 'post.error'; label?: string; agent?: AgentMeta }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string }
  | { type: 'debug'; label: string; body?: string };

/**
 * Exhaustiveness helper — place as the `default` branch of any switch over
 * RadarEvent.type so that adding a new variant fails the build until every
 * sink handles it (or explicitly ignores it via a `default:` case).
 */
export function assertNever(e: never): never {
  throw new Error(`Unhandled RadarEvent type: ${(e as { type: string }).type}`);
}
