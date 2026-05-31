/**
 * Snapshot test for LogSink.
 *
 * Feeds a fixed event stream through LogSink, captures stdout, strips ANSI
 * codes and normalises timestamps (HH:MM:SS → HH:MM:SS placeholder) so the
 * golden file is deterministic regardless of when the test runs.
 *
 * To regenerate the golden file after an intentional output change:
 *   UPDATE_SNAPSHOTS=1 npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LogSink } from '../output/sinks/log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, '__snapshots__');
const GOLDEN_PATH = join(GOLDEN_DIR, 'log-sink.golden.txt');

// ── Capture helpers ───────────────────────────────────────────────────────────

let captured = '';
let originalWrite: typeof process.stdout.write;

function startCapture(): void {
  captured = '';
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    captured += String(chunk);
    return true;
  };
}

function stopCapture(): string {
  process.stdout.write = originalWrite;
  return captured;
}

// ── Normalisation ─────────────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Replace HH:MM:SS timestamps so the golden file is time-invariant. */
function normalise(str: string): string {
  return stripAnsi(str).replace(/\d{2}:\d{2}:\d{2}/g, 'HH:MM:SS');
}

// ── Fixture streams ───────────────────────────────────────────────────────────

test('LogSink snapshot — alert-only mode (verbose=false)', () => {
  startCapture();

  const sink = new LogSink({ verbose: false });

  // Startup
  sink.emit({ type: 'banner', port: 4820 });
  sink.emit({ type: 'session.connected', label: 'S1', sessionId: 'abcd1234efgh5678' });

  // 3 suppressed pre.clear events
  sink.emit({ type: 'pre.clear', label: 'S1', score: 0.34 });
  sink.emit({ type: 'pre.clear', label: 'S1', score: 0.28 });
  sink.emit({ type: 'pre.clear', label: 'S2', score: 0.41 });

  // New session (flush=3 before session.connected)
  sink.emit({ type: 'session.connected', label: 'S2', sessionId: 'efgh5678abcd1234' });

  // Pre-advisory (flush=0 now; S2 session flushed the count)
  sink.emit({ type: 'pre.advisory', label: 'S1', score: 0.82, advisory: 'This prompt is ambiguous. Try specifying a target file.' });

  // 2 suppressed post.aligned events
  sink.emit({ type: 'post.aligned', label: 'S1', score: 0.82, summary: 'Added tests for processOrder' });
  sink.emit({ type: 'post.aligned', label: 'S2', score: 0.35, summary: 'Answered the question' });

  // Misaligned (flush=2 before the red box)
  sink.emit({ type: 'post.misaligned', label: 'S1', advisory: 'Scope exceeded: 5 files edited, expected 2' });

  // Warnings and errors (no flush needed — count=0 after last flush)
  sink.emit({ type: 'warning', message: 'OTel env vars not configured. Run `radar setup`.' });
  sink.emit({ type: 'error', message: 'Post-advisory failed for prompt abc123: timeout' });

  const output = normalise(stopCapture());

  mkdirSync(GOLDEN_DIR, { recursive: true });

  if (process.env['UPDATE_SNAPSHOTS'] === '1' || !existsSync(GOLDEN_PATH)) {
    writeFileSync(GOLDEN_PATH, output, 'utf-8');
    // First run: write golden and pass
    return;
  }

  const golden = readFileSync(GOLDEN_PATH, 'utf-8');
  assert.equal(output, golden, 'LogSink output does not match golden file. Run UPDATE_SNAPSHOTS=1 npm test to regenerate.');
});

test('LogSink snapshot — verbose mode (verbose=true)', () => {
  startCapture();

  const sink = new LogSink({ verbose: true });

  sink.emit({ type: 'banner', port: 4820 });
  sink.emit({ type: 'session.connected', label: 'S1', sessionId: 'abcd1234efgh5678' });

  // pre.clear is printed in verbose mode
  sink.emit({ type: 'pre.clear', label: 'S1', score: 0.34 });
  sink.emit({ type: 'pre.clear', label: 'S1', score: 0.28 });

  sink.emit({ type: 'pre.advisory', label: 'S1', score: 0.82, advisory: 'Ambiguous scope.' });

  // post.aligned is printed in verbose mode
  sink.emit({ type: 'post.aligned', label: 'S1', score: 0.82, summary: 'Added tests' });

  sink.emit({ type: 'post.misaligned', label: 'S1', advisory: 'Scope exceeded' });

  sink.emit({ type: 'warning', message: 'A warning' });
  sink.emit({ type: 'error', message: 'An error' });

  const output = normalise(stopCapture());

  const verboseGoldenPath = join(GOLDEN_DIR, 'log-sink-verbose.golden.txt');

  if (process.env['UPDATE_SNAPSHOTS'] === '1' || !existsSync(verboseGoldenPath)) {
    writeFileSync(verboseGoldenPath, output, 'utf-8');
    return;
  }

  const golden = readFileSync(verboseGoldenPath, 'utf-8');
  assert.equal(output, golden, 'LogSink verbose output does not match golden file. Run UPDATE_SNAPSHOTS=1 npm test to regenerate.');
});
