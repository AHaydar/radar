import { EventEmitter } from 'events';
import * as http from 'http';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RadarEventType =
  | 'user_prompt'
  | 'tool_result'
  | 'api_request'
  | 'api_error'
  | 'unknown';

export interface BaseEvent {
  type: RadarEventType;
  promptId: string;
  sessionId: string;
  timestampMs: number;
}

export interface UserPromptEvent extends BaseEvent {
  type: 'user_prompt';
  prompt: string;
  promptLength: number;
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  toolName: string;
  success: boolean;
  durationMs: number;
  toolParameters?: string;
  resultSizeBytes?: number;
}

export interface ApiRequestEvent extends BaseEvent {
  type: 'api_request';
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface ApiErrorEvent extends BaseEvent {
  type: 'api_error';
  error: string;
  statusCode?: number;
}

export type RadarEvent =
  | UserPromptEvent
  | ToolResultEvent
  | ApiRequestEvent
  | ApiErrorEvent;

// ─── OTLP JSON shape (minimal) ────────────────────────────────────────────────

interface OtlpAttributeValue {
  stringValue?: string;
  intValue?: number;
  doubleValue?: number;
  boolValue?: boolean;
}

interface OtlpAttribute {
  key: string;
  value: OtlpAttributeValue;
}

interface OtlpLogRecord {
  timeUnixNano?: string;
  severityNumber?: number;
  body?: { stringValue?: string };
  attributes?: OtlpAttribute[];
}

interface OtlpScopeLogs {
  scope?: { name?: string };
  logRecords?: OtlpLogRecord[];
}

interface OtlpResourceLogs {
  resource?: { attributes?: OtlpAttribute[] };
  scopeLogs?: OtlpScopeLogs[];
}

interface OtlpLogsPayload {
  resourceLogs?: OtlpResourceLogs[];
}

// ─── Attribute helpers ────────────────────────────────────────────────────────

type AttrValue = string | number | boolean | undefined;

/** Build a lookup Map from an attribute array — O(n) once, then O(1) per key. */
function buildAttrMap(attrs: OtlpAttribute[] | undefined): Map<string, AttrValue> {
  const map = new Map<string, AttrValue>();
  if (!attrs) return map;
  for (const a of attrs) {
    const v = a.value;
    if (v.stringValue !== undefined) map.set(a.key, v.stringValue);
    else if (v.intValue !== undefined) map.set(a.key, v.intValue);
    else if (v.doubleValue !== undefined) map.set(a.key, v.doubleValue);
    else if (v.boolValue !== undefined) map.set(a.key, v.boolValue);
  }
  return map;
}

function getString(map: Map<string, AttrValue>, key: string): string {
  const v = map.get(key);
  return typeof v === 'string' ? v : '';
}

function getNumber(map: Map<string, AttrValue>, key: string): number {
  const v = map.get(key);
  return typeof v === 'number' ? v : 0;
}

function getBool(map: Map<string, AttrValue>, key: string): boolean {
  const v = map.get(key);
  return typeof v === 'boolean' ? v : false;
}

// ─── Log record → RadarEvent ──────────────────────────────────────────────────

function parseLogRecord(record: OtlpLogRecord, sessionId: string): RadarEvent | null {
  const eventName = record.body?.stringValue ?? '';

  // timeUnixNano is a string representing nanoseconds (may exceed JS safe int)
  const timeNano = record.timeUnixNano ?? '0';
  const timestampMs = Math.floor(Number(BigInt(timeNano) / 1_000_000n));

  // Build the attribute Map once — O(n) — then do O(1) lookups below
  const attrs = buildAttrMap(record.attributes);

  const promptId = getString(attrs, 'prompt.id');
  const base: BaseEvent = { type: 'unknown', promptId, sessionId, timestampMs };

  switch (eventName) {
    case 'claude_code.user_prompt': {
      const e: UserPromptEvent = {
        ...base,
        type: 'user_prompt',
        prompt: getString(attrs, 'prompt'),
        promptLength: getNumber(attrs, 'prompt_length'),
      };
      return e;
    }

    case 'claude_code.tool_result': {
      const e: ToolResultEvent = {
        ...base,
        type: 'tool_result',
        toolName: getString(attrs, 'tool_name'),
        success: getBool(attrs, 'success'),
        durationMs: getNumber(attrs, 'duration_ms'),
      };
      const toolParameters = getString(attrs, 'tool_parameters');
      if (toolParameters) e.toolParameters = toolParameters;
      const resultSizeBytes = getNumber(attrs, 'result_size_bytes');
      if (resultSizeBytes) e.resultSizeBytes = resultSizeBytes;
      return e;
    }

    case 'claude_code.api_request': {
      const e: ApiRequestEvent = {
        ...base,
        type: 'api_request',
        model: getString(attrs, 'model'),
        costUsd: getNumber(attrs, 'cost_usd'),
        inputTokens: getNumber(attrs, 'input_tokens'),
        outputTokens: getNumber(attrs, 'output_tokens'),
        durationMs: getNumber(attrs, 'duration_ms'),
      };
      return e;
    }

    case 'claude_code.api_error': {
      const e: ApiErrorEvent = {
        ...base,
        type: 'api_error',
        error: getString(attrs, 'error'),
      };
      const statusCode = getNumber(attrs, 'status_code');
      if (statusCode) e.statusCode = statusCode;
      return e;
    }

    default:
      return null;
  }
}

// ─── OtlpReceiver ─────────────────────────────────────────────────────────────

export class OtlpReceiver extends EventEmitter {
  private readonly port: number;
  private readonly fallbackSessionId: string;
  private server: http.Server | null = null;

  constructor(port = 4820) {
    super();
    this.port = port;
    this.fallbackSessionId = `radar-${Math.random().toString(36).slice(2, 10)}`;
  }

  private deriveSessionId(resourceAttrs: Map<string, AttrValue>): string {
    const sessionId = resourceAttrs.get('session.id');
    if (typeof sessionId === 'string' && sessionId) return sessionId;

    const instanceId = resourceAttrs.get('service.instance.id');
    if (typeof instanceId === 'string' && instanceId) return instanceId;

    const pid = resourceAttrs.get('process.pid');
    if (pid !== undefined) return String(pid);

    return this.fallbackSessionId;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      server.on('error', (err) => {
        this.emit('error', err);
      });

      server.listen(this.port, () => {
        this.server = server;
        resolve();
      });

      // If listen itself throws before the callback
      server.once('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
      this.server = null;
    });
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method !== 'POST' || req.url !== '/v1/logs') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    req.on('end', () => {
      // Respond immediately — never block
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ partialSuccess: {} }));

      const body = Buffer.concat(chunks).toString('utf8');
      let payload: OtlpLogsPayload;

      try {
        payload = JSON.parse(body) as OtlpLogsPayload;
      } catch (err) {
        process.stderr.write(`[radar/otlp] malformed JSON: ${String(err)}\n`);
        return;
      }

      this.processPayload(payload);
    });

    req.on('error', (err) => {
      process.stderr.write(`[radar/otlp] request error: ${String(err)}\n`);
    });
  }

  private processPayload(payload: OtlpLogsPayload): void {
    for (const resourceLog of payload.resourceLogs ?? []) {
      const resourceAttrs = buildAttrMap(resourceLog.resource?.attributes);
      const sessionId = this.deriveSessionId(resourceAttrs);
      for (const scopeLog of resourceLog.scopeLogs ?? []) {
        for (const record of scopeLog.logRecords ?? []) {
          const event = parseLogRecord(record, sessionId);
          if (event) {
            this.emit('event', event);
          }
        }
      }
    }
  }
}
