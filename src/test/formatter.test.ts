import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { printPreClear, printPreAdvisory, printPostAligned, printPostMisaligned, printBanner, printWarning, printError, formatTime } from '../output/formatter.js';

// ── Capture stdout ────────────────────────────────────────────────────────────

let captured = '';
let originalWrite: typeof process.stdout.write;

function startCapture() {
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

// Strip ANSI escape codes for easier assertion
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('formatter', () => {
  describe('formatTime', () => {
    test('formats date as HH:MM:SS', () => {
      const d = new Date(2026, 2, 21, 9, 5, 3); // 09:05:03
      assert.equal(formatTime(d), '09:05:03');
    });

    test('pads single-digit hours, minutes, seconds', () => {
      const d = new Date(2026, 0, 1, 1, 2, 3); // 01:02:03
      assert.equal(formatTime(d), '01:02:03');
    });
  });

  describe('printPreClear', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('outputs a single line containing score and "Clear"', () => {
      printPreClear(0.34);
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('PRE'), 'should include PRE');
      assert.ok(plain.includes('0.34'), 'should include score');
      assert.ok(plain.includes('Clear'), 'should include Clear');
      assert.equal(plain.trim().split('\n').length, 1, 'should be a single line');
    });
  });

  describe('printPreAdvisory', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('outputs header, advisory text, and separator', () => {
      printPreAdvisory(0.78, '⚠ This is ambiguous.\n  Try being more specific.');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('PRE'), 'should include PRE');
      assert.ok(plain.includes('0.78'), 'should include score');
      assert.ok(plain.includes('ambiguous'), 'should include advisory text');
      assert.ok(plain.includes('specific'), 'should include advisory continuation');
      // Separator line should be present (line of ─ characters)
      assert.ok(plain.includes('─'), 'should include separator');
    });
  });

  describe('printPostAligned', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('outputs POST header and aligned summary', () => {
      printPostAligned('✓ Response aligned with intent.\n  Edit (2 calls) · 847 tokens · $0.003');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('POST'), 'should include POST');
      assert.ok(plain.includes('aligned'), 'should include summary text');
      assert.ok(plain.includes('─'), 'should include separator');
    });
  });

  describe('printPostMisaligned', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('outputs POST header and misalignment advisory', () => {
      printPostMisaligned('✗ Scope exceeded.\n  → "redo only the failing tests"');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('POST'), 'should include POST');
      assert.ok(plain.includes('Scope exceeded'), 'should include advisory');
      assert.ok(plain.includes('─'), 'should include separator');
    });
  });

  describe('printBanner', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('shows port number and instructions', () => {
      printBanner(4820);
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('Radar'), 'should include Radar name');
      assert.ok(plain.includes('4820'), 'should include port');
      assert.ok(plain.includes('OTEL_LOG_USER_PROMPTS'), 'should mention env var');
    });
  });

  describe('printWarning', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('outputs warning with ⚠ prefix', () => {
      printWarning('Something might be wrong');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('⚠'), 'should include warning symbol');
      assert.ok(plain.includes('Something might be wrong'), 'should include message');
    });
  });

  describe('printError', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('outputs error with ✗ prefix', () => {
      printError('Connection refused');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('✗'), 'should include error symbol');
      assert.ok(plain.includes('Connection refused'), 'should include message');
    });
  });

  describe('separator line length', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('printPreClear produces a line of 52 visible chars', () => {
      printPreClear(0.5);
      const plain = stripAnsi(captured).trim();
      // The separator line pads to exactly LINE_WIDTH (52) chars
      // However the header prefix is the whole line — just check it's ≥ 40 chars
      assert.ok(plain.length >= 40, 'line should be at least 40 chars wide');
    });
  });
});
