import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { OtlpReceiver } from '../receiver/otlp.js';
import type { RadarEvent, UserPromptEvent, ToolResultEvent, ApiRequestEvent, ApiErrorEvent } from '../receiver/otlp.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const tick = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── Helper: post a payload to the receiver ────────────────────────────────────

function postLogs(port: number, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: '/v1/logs',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Sample OTLP payloads ──────────────────────────────────────────────────────

function makeLogRecord(
  eventName: string,
  attrs: Array<{ key: string; value: Record<string, unknown> }>,
  timeUnixNano = '1711000000000000000',
  resourceAttrs?: Array<{ key: string; value: Record<string, unknown> }>,
) {
  return {
    resourceLogs: [
      {
        resource: resourceAttrs !== undefined ? { attributes: resourceAttrs } : undefined,
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano,
                body: { stringValue: eventName },
                attributes: attrs,
              },
            ],
          },
        ],
      },
    ],
  };
}

const TEST_PORT = 14820;

describe('OtlpReceiver', () => {
  let receiver: OtlpReceiver;

  before(async () => {
    receiver = new OtlpReceiver(TEST_PORT);
    await receiver.start();
  });

  after(async () => {
    await receiver.stop();
  });

  test('returns 200 and partialSuccess on POST /v1/logs', async () => {
    const { status, body } = await postLogs(TEST_PORT, { resourceLogs: [] });
    assert.equal(status, 200);
    const parsed = JSON.parse(body) as unknown;
    assert.deepEqual(parsed, { partialSuccess: {} });
  });

  test('returns 404 for unknown paths', async () => {
    const res = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request(
        { hostname: 'localhost', port: TEST_PORT, path: '/v1/metrics', method: 'POST' },
        (r) => resolve({ status: r.statusCode ?? 0 }),
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(res.status, 404);
  });

  test('parses user_prompt event correctly', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, makeLogRecord('claude_code.user_prompt', [
      { key: 'prompt.id', value: { stringValue: 'test-prompt-001' } },
      { key: 'prompt', value: { stringValue: 'fix the auth bug in login.ts' } },
      { key: 'prompt_length', value: { intValue: 30 } },
    ]));

    // Give the server a tick to process
    await tick();
    receiver.off('event', listener);

    const evt = collected.find((e) => e.type === 'user_prompt') as UserPromptEvent | undefined;
    assert.ok(evt, 'should emit a user_prompt event');
    assert.equal(evt.promptId, 'test-prompt-001');
    assert.equal(evt.prompt, 'fix the auth bug in login.ts');
    assert.equal(evt.promptLength, 30);
    assert.equal(typeof evt.sessionId, 'string');
    assert.ok(evt.sessionId.length > 0);
  });

  test('parses tool_result event correctly', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, makeLogRecord('claude_code.tool_result', [
      { key: 'prompt.id', value: { stringValue: 'test-prompt-002' } },
      { key: 'tool_name', value: { stringValue: 'Edit' } },
      { key: 'success', value: { boolValue: true } },
      { key: 'duration_ms', value: { intValue: 123 } },
      { key: 'result_size_bytes', value: { intValue: 512 } },
    ]));

    await tick();
    receiver.off('event', listener);

    const evt = collected.find((e) => e.type === 'tool_result') as ToolResultEvent | undefined;
    assert.ok(evt, 'should emit a tool_result event');
    assert.equal(evt.toolName, 'Edit');
    assert.equal(evt.success, true);
    assert.equal(evt.durationMs, 123);
    assert.equal(evt.resultSizeBytes, 512);
    assert.equal(typeof evt.sessionId, 'string');
    assert.ok(evt.sessionId.length > 0);
  });

  test('parses api_request event correctly', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, makeLogRecord('claude_code.api_request', [
      { key: 'prompt.id', value: { stringValue: 'test-prompt-003' } },
      { key: 'model', value: { stringValue: 'claude-sonnet-4-5' } },
      { key: 'cost_usd', value: { doubleValue: 0.00321 } },
      { key: 'input_tokens', value: { intValue: 450 } },
      { key: 'output_tokens', value: { intValue: 120 } },
      { key: 'duration_ms', value: { intValue: 2800 } },
    ]));

    await tick();
    receiver.off('event', listener);

    const evt = collected.find((e) => e.type === 'api_request') as ApiRequestEvent | undefined;
    assert.ok(evt, 'should emit an api_request event');
    assert.equal(evt.model, 'claude-sonnet-4-5');
    assert.equal(evt.inputTokens, 450);
    assert.equal(evt.outputTokens, 120);
    assert.equal(evt.durationMs, 2800);
    assert.equal(typeof evt.sessionId, 'string');
    assert.ok(evt.sessionId.length > 0);
  });

  test('parses api_error event correctly', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, makeLogRecord('claude_code.api_error', [
      { key: 'prompt.id', value: { stringValue: 'test-prompt-004' } },
      { key: 'error', value: { stringValue: 'Rate limit exceeded' } },
      { key: 'status_code', value: { intValue: 429 } },
    ]));

    await tick();
    receiver.off('event', listener);

    const evt = collected.find((e) => e.type === 'api_error') as ApiErrorEvent | undefined;
    assert.ok(evt, 'should emit an api_error event');
    assert.equal(evt.error, 'Rate limit exceeded');
    assert.equal(evt.statusCode, 429);
    assert.equal(typeof evt.sessionId, 'string');
    assert.ok(evt.sessionId.length > 0);
  });

  test('silently skips unknown event types', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, makeLogRecord('claude_code.unknown_future_event', [
      { key: 'prompt.id', value: { stringValue: 'test-prompt-005' } },
    ]));

    await tick();
    receiver.off('event', listener);

    assert.equal(collected.length, 0, 'unknown events should not be emitted');
  });

  test('handles malformed JSON without crashing', async () => {
    const { status } = await new Promise<{ status: number }>((resolve, reject) => {
      const data = 'this is not json {{{';
      const req = http.request(
        {
          hostname: 'localhost',
          port: TEST_PORT,
          path: '/v1/logs',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    // Server responds 200 before parsing — malformed JSON logged to stderr
    assert.equal(status, 200);
  });

  test('processes multiple log records in one payload', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, {
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1711000000000000000',
                  body: { stringValue: 'claude_code.user_prompt' },
                  attributes: [
                    { key: 'prompt.id', value: { stringValue: 'batch-001' } },
                    { key: 'prompt', value: { stringValue: 'test prompt' } },
                    { key: 'prompt_length', value: { intValue: 11 } },
                  ],
                },
                {
                  timeUnixNano: '1711000001000000000',
                  body: { stringValue: 'claude_code.tool_result' },
                  attributes: [
                    { key: 'prompt.id', value: { stringValue: 'batch-001' } },
                    { key: 'tool_name', value: { stringValue: 'Read' } },
                    { key: 'success', value: { boolValue: true } },
                    { key: 'duration_ms', value: { intValue: 50 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    await tick();
    receiver.off('event', listener);

    assert.equal(collected.length, 2);
    assert.equal(collected[0].type, 'user_prompt');
    assert.equal(collected[1].type, 'tool_result');
    assert.equal(typeof collected[0].sessionId, 'string');
    assert.ok(collected[0].sessionId.length > 0);
  });

  test('prefers session.id from log record attributes over resource-derived session ID', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    // Simulates the real Claude Code OTel shape: no resource session.id,
    // but session.id present as a log record attribute (matching what the Stop hook sends).
    await postLogs(TEST_PORT, makeLogRecord(
      'claude_code.user_prompt',
      [
        { key: 'prompt.id', value: { stringValue: 'log-attr-sess-001' } },
        { key: 'session.id', value: { stringValue: 'real-claude-session-uuid' } },
        { key: 'prompt', value: { stringValue: 'test' } },
        { key: 'prompt_length', value: { intValue: 4 } },
      ],
      // No resource attributes — would produce fallback 'radar-xxxx' session ID
    ));

    await tick();
    receiver.off('event', listener);

    const evt = collected.find((e) => e.type === 'user_prompt');
    assert.ok(evt, 'should emit a user_prompt event');
    assert.equal(evt.sessionId, 'real-claude-session-uuid',
      'log-record session.id should take priority over fallback resource-derived ID');
  });

  test('extracts session.id from resource attributes', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, makeLogRecord(
      'claude_code.user_prompt',
      [
        { key: 'prompt.id', value: { stringValue: 'sess-prompt-001' } },
        { key: 'prompt', value: { stringValue: 'test' } },
        { key: 'prompt_length', value: { intValue: 4 } },
      ],
      '1711000000000000000',
      [{ key: 'session.id', value: { stringValue: 'sess-abc' } }],
    ));

    await tick();
    receiver.off('event', listener);

    const evt = collected.find((e) => e.type === 'user_prompt');
    assert.ok(evt, 'should emit a user_prompt event');
    assert.equal(evt.sessionId, 'sess-abc');
  });

  test('falls back to process.pid when no session.id', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, makeLogRecord(
      'claude_code.user_prompt',
      [
        { key: 'prompt.id', value: { stringValue: 'pid-prompt-001' } },
        { key: 'prompt', value: { stringValue: 'test' } },
        { key: 'prompt_length', value: { intValue: 4 } },
      ],
      '1711000000000000000',
      [{ key: 'process.pid', value: { intValue: 9999 } }],
    ));

    await tick();
    receiver.off('event', listener);

    const evt = collected.find((e) => e.type === 'user_prompt');
    assert.ok(evt, 'should emit a user_prompt event');
    assert.equal(evt.sessionId, '9999');
  });

  test('uses fallback sessionId when no resource attributes', async () => {
    const collected: RadarEvent[] = [];
    const listener = (e: RadarEvent) => collected.push(e);
    receiver.on('event', listener);

    await postLogs(TEST_PORT, makeLogRecord(
      'claude_code.user_prompt',
      [
        { key: 'prompt.id', value: { stringValue: 'fallback-prompt-001' } },
        { key: 'prompt', value: { stringValue: 'test' } },
        { key: 'prompt_length', value: { intValue: 4 } },
      ],
    ));

    await tick();
    receiver.off('event', listener);

    const evt = collected.find((e) => e.type === 'user_prompt');
    assert.ok(evt, 'should emit a user_prompt event');
    assert.equal(typeof evt.sessionId, 'string');
    assert.ok(evt.sessionId.length > 0);
    assert.ok(evt.sessionId.startsWith('radar-'));
  });
});
