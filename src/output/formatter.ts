// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';

// ─── Constants ────────────────────────────────────────────────────────────────

const LINE_WIDTH = 52;
const WRAP_WIDTH = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Format a Date as "HH:MM:SS".
 */
export function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Build a separator line of exactly LINE_WIDTH chars, padded with "─".
 * The prefix is included in the total width.
 */
function separator(prefix = ''): string {
  const dashes = '─'.repeat(Math.max(0, LINE_WIDTH - prefix.length));
  return prefix + dashes;
}

/**
 * Wrap text to at most maxWidth characters per line, preserving existing newlines.
 * Continuation lines are indented with `indent` spaces.
 */
function wrapText(text: string, maxWidth: number, indent: string): string[] {
  const rawLines = text.split('\n');
  const result: string[] = [];

  for (const rawLine of rawLines) {
    const words = rawLine.split(' ');
    let current = '';

    for (const word of words) {
      if (current === '') {
        current = word;
      } else if (current.length + 1 + word.length <= maxWidth) {
        current += ' ' + word;
      } else {
        result.push(current);
        current = indent + word;
      }
    }

    if (current !== '') {
      result.push(current);
    }
  }

  return result;
}

/**
 * Render advisory text as output lines. The first line is left as-is (the
 * caller has already formatted it). Subsequent lines and long first lines are
 * word-wrapped at WRAP_WIDTH with a 2-space indent on continuations.
 */
function renderAdvisoryLines(advisory: string): string[] {
  return wrapText(advisory.trim(), WRAP_WIDTH, '  ');
}

function writeln(text = ''): void {
  process.stdout.write(text + '\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Print a "clear" one-liner — dim, no box.
 *
 * Example:
 *   ── PRE ── 14:23:07 ── score: 0.34 ── ✓ Clear ─────
 *   ── PRE [S1] ── 14:23:07 ── score: 0.34 ── ✓ Clear ─────
 */
export function printPreClear(score: number, sessionLabel?: string): void {
  const time = formatTime(new Date());
  const sessionPart = sessionLabel ? ` [${sessionLabel}]` : '';
  const prefix = `── PRE${sessionPart} ── ${time} ── score: ${score.toFixed(2)} ── ✓ Clear `;
  const line = separator(prefix);
  writeln(DIM + line + RESET);
}

/**
 * Print a pre-advisory warning box with a yellow header.
 *
 * Example:
 *   ── PRE ── 14:25:12 ── score: 0.78 ─────────────────
 *   ── PRE [S1] ── 14:25:12 ── score: 0.78 ─────────────────
 */
export function printPreAdvisory(score: number, advisory: string, sessionLabel?: string): void {
  const time = formatTime(new Date());
  const sessionPart = sessionLabel ? ` [${sessionLabel}]` : '';
  const headerPrefix = `── PRE${sessionPart} ── ${time} ── score: ${score.toFixed(2)} `;
  const header = separator(headerPrefix);

  writeln(YELLOW + BOLD + header + RESET);

  const lines = renderAdvisoryLines(advisory);
  for (const line of lines) {
    writeln(line);
  }

  writeln(DIM + separator() + RESET);
}

/** Shared implementation for both post-advisory box variants. */
function printPost(color: string, content: string, sessionLabel?: string): void {
  const time = formatTime(new Date());
  const sessionPart = sessionLabel ? ` [${sessionLabel}]` : '';
  const header = separator(`── POST${sessionPart} ── ${time} `);

  writeln(color + BOLD + header + RESET);

  const lines = renderAdvisoryLines(content);
  for (const line of lines) {
    writeln(line);
  }

  writeln(DIM + separator() + RESET);
}

/**
 * Print a post-advisory "aligned" box with a green header.
 *
 * Example:
 *   ── POST ── 14:25:38 ────────────────────────────────
 *   ── POST [S1] ── 14:25:38 ────────────────────────────────
 */
export function printPostAligned(summary: string, sessionLabel?: string): void {
  printPost(GREEN, summary, sessionLabel);
}

/**
 * Print a post-advisory "misaligned" box with a red header.
 *
 * Example:
 *   ── POST ── 14:31:02 ────────────────────────────────
 *   ── POST [S1] ── 14:31:02 ────────────────────────────────
 */
export function printPostMisaligned(advisory: string, sessionLabel?: string): void {
  printPost(RED, advisory, sessionLabel);
}

/**
 * Print a dim cyan session-connected line.
 *
 * Example:
 *   ── S1 connected (abcd1234…) ── 14:23:07
 */
export function printSessionStart(label: string, sessionId: string): void {
  const time = formatTime(new Date());
  const shortId = sessionId.slice(0, 8);
  writeln(DIM + CYAN + `── ${label} connected (${shortId}…) ── ${time}` + RESET);
}

/**
 * Print the startup banner.
 *
 * Example:
 *   ── Radar v0.1.0 ────────────────────────────────────
 *   Listening on localhost:4820
 *   Waiting for Claude Code telemetry...
 *   Set OTEL_LOG_USER_PROMPTS=1 for prompt content analysis.
 *   ────────────────────────────────────────────────────
 */
export function printBanner(port: number): void {
  const headerPrefix = '── Radar v0.1.0 ';
  const header = separator(headerPrefix);

  writeln(CYAN + BOLD + header + RESET);
  writeln(`Listening on localhost:${port}`);
  writeln('Waiting for Claude Code telemetry...');
  writeln('Set OTEL_LOG_USER_PROMPTS=1 for prompt content analysis.');
  writeln(DIM + separator() + RESET);
}

/**
 * Print a warning message in yellow.
 */
export function printWarning(message: string): void {
  writeln(YELLOW + '⚠ ' + message + RESET);
}

/**
 * Print an error message in red.
 */
export function printError(message: string): void {
  writeln(RED + '✗ ' + message + RESET);
}
