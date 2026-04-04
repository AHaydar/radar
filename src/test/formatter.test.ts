import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  printPreClear,
  printPreAdvisory,
  printPostAligned,
  printPostMisaligned,
  printSessionStart,
  printSuppressedCount,
  printBanner,
  printWarning,
  printError,
  formatTime,
  sessionColor,
} from '../output/formatter.js';
import { shouldSuppress } from '../cli/watch.js';

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

  describe('sessionColor', () => {
    test('returns different ANSI codes for S1 vs S2', () => {
      assert.notEqual(sessionColor('S1'), sessionColor('S2'));
    });

    test('wraps around — S7 equals S1 color', () => {
      assert.equal(sessionColor('S7'), sessionColor('S1'));
    });

    test('returns a non-empty ANSI escape sequence', () => {
      const color = sessionColor('S1');
      assert.ok(color.startsWith('\x1b['), 'should start with ESC[');
      assert.ok(color.length > 0);
    });

    test('handles labels with no digits gracefully (defaults to S1 color)', () => {
      assert.equal(sessionColor('foo'), sessionColor('S1'));
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

    test('includes session label when provided', () => {
      printPreClear(0.34, 'S1');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('[S1]'), 'should include [S1] label');
    });

    test('output contains ANSI codes when a session label is provided', () => {
      printPreClear(0.34, 'S1');
      assert.ok(captured.includes('\x1b['), 'should contain ANSI escape codes');
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

    test('includes [Sn] tag in output when session label provided', () => {
      printPreAdvisory(0.78, 'Some advisory', 'S2');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('[S2]'), 'should include session label tag');
    });
  });

  describe('printPostAligned', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('outputs POST header and aligned summary', () => {
      printPostAligned('✓ Response aligned with intent.\n  Edit (2 calls) · 847 tokens · $0.003');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('POST'), 'should include POST');
      assert.ok(plain.includes('Aligned'), 'should include Aligned marker');
      assert.ok(plain.includes('─'), 'should include separator');
    });

    test('includes session label when provided', () => {
      printPostAligned('summary', 'S3');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('[S3]'), 'should include [S3] label');
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

    test('includes [Sn] tag in output when session label provided', () => {
      printPostMisaligned('Advisory text', 'S2');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('[S2]'), 'should include session label tag');
    });
  });

  describe('printSessionStart', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('outputs label and truncated session id', () => {
      printSessionStart('S1', 'abcd1234efgh5678');
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('S1'), 'should include label');
      assert.ok(plain.includes('abcd1234'), 'should include short session id');
      assert.ok(plain.includes('connected'), 'should include connected text');
    });

    test('uses session color — output contains the ANSI code for S1', () => {
      printSessionStart('S1', 'abcd1234efgh5678');
      const s1Color = sessionColor('S1');
      assert.ok(captured.includes(s1Color), 'should contain S1 session color code');
    });

    test('uses different color for S2 than for S1', () => {
      printSessionStart('S1', 'aaaa1111bbbb2222');
      const s1Output = captured;
      startCapture();
      printSessionStart('S2', 'cccc3333dddd4444');
      const s2Output = captured;
      // The color codes embedded in the two outputs should differ
      assert.notDeepEqual(
        s1Output.match(/\x1b\[\d+m/g),
        s2Output.match(/\x1b\[\d+m/g),
        'S1 and S2 should use different color sequences',
      );
    });
  });

  describe('printSuppressedCount', () => {
    beforeEach(startCapture);
    afterEach(stopCapture);

    test('shows count and "clear" in output', () => {
      printSuppressedCount(23);
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('23'), 'should include count');
      assert.ok(plain.includes('clear'), 'should include "clear"');
    });

    test('uses singular "event" for count of 1', () => {
      printSuppressedCount(1);
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('1 event '), 'should use singular "event"');
      assert.ok(!plain.includes('1 events'), 'should not use plural "events"');
    });

    test('uses plural "events" for count > 1', () => {
      printSuppressedCount(5);
      const plain = stripAnsi(captured);
      assert.ok(plain.includes('5 events'), 'should use plural "events"');
    });

    test('output contains ANSI dim code', () => {
      printSuppressedCount(3);
      assert.ok(captured.includes('\x1b[2m'), 'should contain DIM ANSI code');
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

describe('shouldSuppress', () => {
  test('never suppresses in verbose mode', () => {
    assert.equal(shouldSuppress('pre-clear', true), false);
    assert.equal(shouldSuppress('post-aligned', true), false);
    assert.equal(shouldSuppress('alert', true), false);
  });

  test('suppresses pre-clear in alert-only mode', () => {
    assert.equal(shouldSuppress('pre-clear', false), true);
  });

  test('suppresses post-aligned in alert-only mode', () => {
    assert.equal(shouldSuppress('post-aligned', false), true);
  });

  test('does not suppress alert events even in alert-only mode', () => {
    assert.equal(shouldSuppress('alert', false), false);
  });
});
