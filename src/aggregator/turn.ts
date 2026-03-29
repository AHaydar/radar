import { EventEmitter } from 'events';
import type {
  UserPromptEvent,
  ToolResultEvent,
  ApiRequestEvent,
  ApiErrorEvent,
} from '../receiver/otlp.js';

export interface ToolResultSummary {
  toolName: string;
  success: boolean;
  durationMs: number;
  bashCommand?: string;
  resultSizeBytes?: number;
}

export interface ApiRequestSummary {
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface SessionSummary {
  sessionId: string;
  label: string;           // "S1", "S2", etc.
  turnCount: number;       // turns started
  completedTurns: number;  // turns that hit boundary timeout
  startedAt: number;       // ms since epoch
  lastSeenAt: number;      // ms since epoch
  totalCostUsd: number;    // sum across completed turns
}

export interface TurnContext {
  promptId: string;
  sessionId: string;
  prompt: string;
  promptLength: number;
  startedAt: number;
  toolResults: ToolResultSummary[];
  apiRequests: ApiRequestSummary[];
  errors: string[];
  // Computed helpers:
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolNames: string[];
}

export interface TurnAggregatorOptions {
  boundaryTimeoutMs?: number;
  cleanupAfterMs?: number;
}

type InternalTurnContext = Omit<
  TurnContext,
  'totalCostUsd' | 'totalInputTokens' | 'totalOutputTokens' | 'toolNames'
>;


function extractBashCommand(toolParameters: unknown): string | undefined {
  if (toolParameters === undefined || toolParameters === null) return undefined;

  if (typeof toolParameters === 'string') {
    try {
      const parsed = JSON.parse(toolParameters) as unknown;
      if (typeof parsed === 'object' && parsed !== null && 'command' in parsed) {
        const cmd = (parsed as Record<string, unknown>).command;
        if (typeof cmd === 'string') {
          return cmd.slice(0, 200);
        }
      }
    } catch {
      // not JSON — fall back to raw string truncated
      return toolParameters.slice(0, 200);
    }
  }

  if (typeof toolParameters === 'object' && 'command' in (toolParameters as object)) {
    const cmd = (toolParameters as Record<string, unknown>).command;
    if (typeof cmd === 'string') {
      return cmd.slice(0, 200);
    }
  }

  return undefined;
}

function buildPublicContext(internal: InternalTurnContext): TurnContext {
  const totalCostUsd = internal.apiRequests.reduce((sum, r) => sum + r.costUsd, 0);
  const totalInputTokens = internal.apiRequests.reduce((sum, r) => sum + r.inputTokens, 0);
  const totalOutputTokens = internal.apiRequests.reduce((sum, r) => sum + r.outputTokens, 0);
  const toolNames = [...new Set(internal.toolResults.map((t) => t.toolName))];

  return {
    ...internal,
    totalCostUsd,
    totalInputTokens,
    totalOutputTokens,
    toolNames,
  };
}

export class TurnAggregator extends EventEmitter {
  private readonly boundaryTimeoutMs: number;
  private readonly cleanupAfterMs: number;

  private readonly contexts = new Map<string, InternalTurnContext>();
  private readonly boundaryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Tracks pending context-cleanup timers so they can be cancelled if a promptId
  // is reused before the cleanup window expires, preventing silent context deletion.
  private readonly cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly sessions = new Map<string, SessionSummary>();
  private sessionCounter = 0;

  constructor(options?: TurnAggregatorOptions) {
    super();
    this.boundaryTimeoutMs = options?.boundaryTimeoutMs ?? 5000;
    this.cleanupAfterMs = options?.cleanupAfterMs ?? 300_000;
  }

  getSessions(): SessionSummary[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): SessionSummary | undefined {
    return this.sessions.get(sessionId);
  }

  addEvent(event: UserPromptEvent | ToolResultEvent | ApiRequestEvent | ApiErrorEvent): void {
    const { promptId } = event;

    const isNew = !this.contexts.has(promptId);

    if (isNew) {
      // Cancel any pending cleanup for this promptId (handles promptId reuse
      // within the cleanup window — prevents an orphaned timer from silently
      // deleting the freshly created context mid-flight).
      const pendingCleanup = this.cleanupTimers.get(promptId);
      if (pendingCleanup !== undefined) {
        clearTimeout(pendingCleanup);
        this.cleanupTimers.delete(promptId);
      }

      const internal: InternalTurnContext = {
        promptId,
        sessionId: event.sessionId,
        prompt: '',
        promptLength: 0,
        startedAt: Date.now(),
        toolResults: [],
        apiRequests: [],
        errors: [],
      };
      this.contexts.set(promptId, internal);

      // Session tracking
      if (!this.sessions.has(event.sessionId)) {
        const session: SessionSummary = {
          sessionId: event.sessionId,
          label: `S${++this.sessionCounter}`,
          turnCount: 1,
          completedTurns: 0,
          startedAt: Date.now(),
          lastSeenAt: Date.now(),
          totalCostUsd: 0,
        };
        this.sessions.set(event.sessionId, session);
        this.emit('session_start', { ...session });
      } else {
        const session = this.sessions.get(event.sessionId)!;
        session.lastSeenAt = Date.now();
        session.turnCount++;
      }
    }

    const ctx = this.contexts.get(promptId)!;

    switch (event.type) {
      case 'user_prompt': {
        ctx.prompt = event.prompt ?? '';
        ctx.promptLength = event.promptLength ?? ctx.prompt.length;
        break;
      }
      case 'tool_result': {
        const summary: ToolResultSummary = {
          toolName: event.toolName,
          success: event.success,
          durationMs: event.durationMs,
          resultSizeBytes: event.resultSizeBytes,
        };
        if (event.toolName === 'Bash') {
          summary.bashCommand = extractBashCommand(event.toolParameters);
        }
        ctx.toolResults.push(summary);
        break;
      }
      case 'api_request': {
        ctx.apiRequests.push({
          model: event.model,
          costUsd: event.costUsd,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          durationMs: event.durationMs,
        });
        break;
      }
      case 'api_error': {
        ctx.errors.push(event.error);
        break;
      }
    }

    if (isNew) {
      this.emit('turn_start', buildPublicContext(ctx));
    }

    this.resetBoundaryTimer(promptId);
  }

  getContext(promptId: string): TurnContext | undefined {
    const internal = this.contexts.get(promptId);
    if (!internal) return undefined;
    return buildPublicContext(internal);
  }

  private resetBoundaryTimer(promptId: string): void {
    const existing = this.boundaryTimers.get(promptId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.boundaryTimers.delete(promptId);
      const internal = this.contexts.get(promptId);
      if (internal) {
        // Update session stats
        const session = this.sessions.get(internal.sessionId);
        if (session) {
          session.completedTurns++;
          session.totalCostUsd += internal.apiRequests.reduce((s, r) => s + r.costUsd, 0);
        }
        this.emit('turn_complete', buildPublicContext(internal));
        // Schedule cleanup — store handle so it can be cancelled if the promptId
        // is reused before the window expires.
        const cleanupTimer = setTimeout(() => {
          this.contexts.delete(promptId);
          this.cleanupTimers.delete(promptId);
        }, this.cleanupAfterMs);
        this.cleanupTimers.set(promptId, cleanupTimer);
      }
    }, this.boundaryTimeoutMs);

    this.boundaryTimers.set(promptId, timer);
  }
}
