import * as http from 'node:http';
import { formatTime } from '../output/formatter.js';

// ─── ANSI helpers (local, keep sniff self-contained) ──────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';

// ─── OTLP types (minimal, mirrors otlp.ts) ────────────────────────────────────

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
  body?: { stringValue?: string };
  attributes?: OtlpAttribute[];
}

interface OtlpScopeLogs {
  logRecords?: OtlpLogRecord[];
}

interface OtlpResourceLogs {
  scopeLogs?: OtlpScopeLogs[];
}

interface OtlpLogsPayload {
  resourceLogs?: OtlpResourceLogs[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function rawAttrValue(v: OtlpAttributeValue): string | number | boolean | undefined {
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return undefined;
}

function attrsToRecord(attrs: OtlpAttribute[] | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const a of attrs ?? []) {
    const v = rawAttrValue(a.value);
    if (v !== undefined) out[a.key] = v;
  }
  return out;
}

// ─── Compact printer ──────────────────────────────────────────────────────────

function printCompact(record: OtlpLogRecord): void {
  const timeNano = record.timeUnixNano ?? '0';
  const timestampMs = Math.floor(Number(BigInt(timeNano) / 1_000_000n));
  const ts = formatTime(new Date(timestampMs));
  const eventName = record.body?.stringValue ?? '(no name)';
  const attrs = attrsToRecord(record.attributes);

  // Highlight known event types
  let nameColour = CYAN;
  if (eventName.includes('user_prompt')) nameColour = GREEN;
  else if (eventName.includes('api_error')) nameColour = YELLOW;

  const attrsStr = Object.keys(attrs).length
    ? `  ${DIM}${JSON.stringify(attrs)}${RESET}`
    : '';

  process.stdout.write(
    `${DIM}${ts}${RESET}  ${nameColour}${BOLD}${eventName}${RESET}${attrsStr}\n`,
  );
}

function printJson(record: OtlpLogRecord): void {
  const timeNano = record.timeUnixNano ?? '0';
  const timestampMs = Math.floor(Number(BigInt(timeNano) / 1_000_000n));
  const eventName = record.body?.stringValue ?? '';
  const attrs = attrsToRecord(record.attributes);

  process.stdout.write(
    JSON.stringify({ timestampMs, eventName, attrs }) + '\n',
  );
}

// ─── Forward helper ───────────────────────────────────────────────────────────

function forwardBody(body: string, forwardPort: number): void {
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port: forwardPort,
      path: '/v1/logs',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    },
    (res) => {
      // Drain response so the socket is released
      res.resume();
    },
  );
  req.on('error', () => {
    // Radar not running — silently swallow; we already responded 200 to Claude Code
  });
  req.write(body);
  req.end();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SniffOptions {
  port?: number;
  forwardPort?: number;
  jsonMode?: boolean;
}

export async function startSniff(options: SniffOptions = {}): Promise<void> {
  const port = options.port ?? 4821;
  const forwardPort = options.forwardPort ?? 4820;
  const jsonMode = options.jsonMode ?? false;

  const server = http.createServer((req, res) => {
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
      // Always respond 200 immediately so Claude Code never stalls
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ partialSuccess: {} }));

      const body = Buffer.concat(chunks).toString('utf8');

      // Forward before parsing so Radar still gets everything even if we throw
      forwardBody(body, forwardPort);

      let payload: OtlpLogsPayload;
      try {
        payload = JSON.parse(body) as OtlpLogsPayload;
      } catch {
        process.stderr.write('[radar/sniff] malformed JSON — skipping print\n');
        return;
      }

      const printer = jsonMode ? printJson : printCompact;

      for (const resourceLog of payload.resourceLogs ?? []) {
        for (const scopeLog of resourceLog.scopeLogs ?? []) {
          for (const record of scopeLog.logRecords ?? []) {
            printer(record);
          }
        }
      }
    });

    req.on('error', (err) => {
      process.stderr.write(`[radar/sniff] request error: ${String(err)}\n`);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve());
  });

  const mode = jsonMode ? 'json' : 'compact';
  process.stdout.write(
    `${BOLD}${CYAN}radar sniff${RESET}  listening on :${port}  forwarding to :${forwardPort}  mode=${mode}\n\n`,
  );

  async function shutdown(): Promise<void> {
    process.stdout.write('\n[radar/sniff] shutting down\n');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  }

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
