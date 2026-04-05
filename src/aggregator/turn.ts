import { EventEmitter } from 'events';
import type {
  UserPromptEvent,
  ToolResultEvent,
  ApiRequestEvent,
  ApiErrorEvent,
  ToolDecisionEvent,
} from '../receiver/otlp.js';
import { buildToolSummary } from './tools.js';

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

export interface ToolDecisionSummary {
  toolName: string;
  decision: string;
  source: string;
}

export interface TurnHistoryEntry {
  prompt: string;
  toolSummary: string;
}

export interface SessionSummary {
  sessionId: string;
  label: string;           // "S1", "S2", etc.
  turnCount: number;       // turns started
  completedTurns: number;  // turns completed via Stop hook
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
  toolDecisions: ToolDecisionSummary[];
  lastAssistantMessage?: string;
  classificationScore?: number;
  // Computed helpers:
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  toolNames: string[];
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
  // Delay to allow in-flight OTel events to arrive after Stop hook fires.
  // Must be longer than OTEL_LOGS_EXPORT_INTERVAL (configured at 2000ms).
  static readonly COMPLETION_DELAY_MS = 3500;

  private readonly contexts = new Map<string, InternalTurnContext>();
  // Maps sessionId → promptId for the most recent active turn
  private readonly activeTurns = new Map<string, string>();
  // Sessions where Stop hook fired before any OTel events arrived.
  // Maps sessionId → lastAssistantMessage (undefined if not provided).
  private readonly pendingStops = new Map<string, string | undefined>();
  // Active delayed-completion timers, keyed by sessionId
  private readonly completionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly sessions = new Map<string, SessionSummary>();
  private sessionCounter = 0;
  private readonly turnHistory = new Map<string, TurnHistoryEntry[]>();

  getSessions(): SessionSummary[] {
    return [...this.sessions.values()];
  }

  getSession(sessionId: string): SessionSummary | undefined {
    return this.sessions.get(sessionId);
  }

  addEvent(
    event: UserPromptEvent | ToolResultEvent | ApiRequestEvent | ApiErrorEvent | ToolDecisionEvent,
  ): void {
    const { promptId } = event;

    const isNew = !this.contexts.has(promptId);

    if (isNew) {
      const internal: InternalTurnContext = {
        promptId,
        sessionId: event.sessionId,
        prompt: '',
        promptLength: 0,
        startedAt: Date.now(),
        toolResults: [],
        apiRequests: [],
        errors: [],
        toolDecisions: [],
      };
      this.contexts.set(promptId, internal);
      this.activeTurns.set(event.sessionId, promptId);

      // If a stop arrived before this turn's OTel events, schedule completion now
      if (this.pendingStops.has(event.sessionId)) {
        const pendingMsg = this.pendingStops.get(event.sessionId);
        this.pendingStops.delete(event.sessionId);
        if (pendingMsg) {
          this.contexts.get(promptId)!.lastAssistantMessage = pendingMsg;
        }
        this._scheduleDelayedComplete(event.sessionId);
      }

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
      case 'tool_decision': {
        ctx.toolDecisions.push({
          toolName: event.toolName,
          decision: event.decision,
          source: event.source,
        });
        break;
      }
    }

    if (isNew) {
      this.emit('turn_start', buildPublicContext(ctx));
    }
  }

  /**
   * Schedule turn completion after the Stop hook fires, with a delay to allow
   * in-flight OTel events to arrive. Handles two cases:
   * - Stop fires after OTel: waits COMPLETION_DELAY_MS then completes.
   * - Stop fires before OTel: stores a pending stop; addEvent will reschedule
   *   once the turn context is created.
   */
  scheduleCompletion(sessionId: string, lastAssistantMessage?: string): void {
    // Cancel any existing timer for this session
    const existing = this.completionTimers.get(sessionId);
    if (existing !== undefined) {
      clearTimeout(existing);
      this.completionTimers.delete(sessionId);
    }

    if (!this.activeTurns.has(sessionId)) {
      // No active turn yet — OTel events haven't arrived.
      // Mark as pending; addEvent will reschedule once the context is created.
      this.pendingStops.set(sessionId, lastAssistantMessage);
      return;
    }

    // Store the assistant message on the active turn context
    const promptId = this.activeTurns.get(sessionId)!;
    const ctx = this.contexts.get(promptId);
    if (ctx && lastAssistantMessage) {
      ctx.lastAssistantMessage = lastAssistantMessage;
    }

    this._scheduleDelayedComplete(sessionId);
  }

  private _scheduleDelayedComplete(sessionId: string): void {
    const timer = setTimeout(() => {
      this.completionTimers.delete(sessionId);
      this.completeTurn(sessionId);
    }, TurnAggregator.COMPLETION_DELAY_MS);
    this.completionTimers.set(sessionId, timer);
  }

  /**
   * Signal that the turn for a given session is complete (called when the Stop
   * hook fires). Emits 'turn_complete' and cleans up the context immediately.
   */
  completeTurn(sessionId: string): void {
    const promptId = this.activeTurns.get(sessionId);
    if (!promptId) return;

    const internal = this.contexts.get(promptId);
    if (!internal) return;

    this.activeTurns.delete(sessionId);

    // Update session stats
    const session = this.sessions.get(sessionId);
    if (session) {
      session.completedTurns++;
      session.totalCostUsd += internal.apiRequests.reduce((s, r) => s + r.costUsd, 0);
    }

    this.emit('turn_complete', buildPublicContext(internal));

    // Update turn history for this session (capped at 3 entries)
    const history = this.turnHistory.get(sessionId) ?? [];
    history.push({
      prompt: internal.prompt,
      toolSummary: buildToolSummary(internal.toolResults),
    });
    if (history.length > 3) history.shift();
    this.turnHistory.set(sessionId, history);

    // Clean up context — turn is done
    this.contexts.delete(promptId);
  }

  getRecentTurns(sessionId: string): TurnHistoryEntry[] {
    return this.turnHistory.get(sessionId) ?? [];
  }

  getContext(promptId: string): TurnContext | undefined {
    const internal = this.contexts.get(promptId);
    if (!internal) return undefined;
    return buildPublicContext(internal);
  }

  setClassificationScore(promptId: string, score: number): void {
    const ctx = this.contexts.get(promptId);
    if (ctx) ctx.classificationScore = score;
  }
}
