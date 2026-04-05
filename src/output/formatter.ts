// ─── ANSI helpers ─────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const BLUE = '\x1b[34m';
const WHITE = '\x1b[37m';

const SESSION_COLORS = [CYAN, MAGENTA, GREEN, YELLOW, BLUE, WHITE];

/**
 * Return the ANSI color code for a session label like "S1", "S2", etc.
 * Cycles through SESSION_COLORS so that S7 wraps back to S1's color.
 */
export function sessionColor(label: string): string {
  const n = parseInt(label.replace(/\D/g, ''), 10) || 1;
  return SESSION_COLORS[(n - 1) % SESSION_COLORS.length];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const LINE_WIDTH = 76;
const WRAP_WIDTH = 74;

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
 * When a session label is provided the whole line is colored with that
 * session's color; otherwise it falls back to plain dim.
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
  const color = sessionLabel ? sessionColor(sessionLabel) : '';
  writeln(DIM + color + line + RESET);
}

/**
 * Print a pre-advisory warning box with a yellow header.
 * The [Sn] tag within the header is colored with the session's color;
 * the rest of the header remains YELLOW + BOLD (alert color takes precedence).
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

  if (sessionLabel) {
    const sColor = sessionColor(sessionLabel);
    // Inject session color around [Sn], then restore YELLOW+BOLD for the rest
    const colored = header.replace(
      `[${sessionLabel}]`,
      `${sColor}[${sessionLabel}]${YELLOW + BOLD}`,
    );
    writeln(YELLOW + BOLD + colored + RESET);
  } else {
    writeln(YELLOW + BOLD + header + RESET);
  }

  const lines = renderAdvisoryLines(advisory);
  for (const line of lines) {
    writeln(line);
  }

  writeln(DIM + separator() + RESET);
}

/**
 * Shared implementation for both post-advisory box variants.
 * For alert lines the [Sn] tag is colored with the session's color while
 * the rest of the header keeps the caller-supplied alert color.
 */
function printPost(color: string, content: string, sessionLabel?: string): void {
  const time = formatTime(new Date());
  const sessionPart = sessionLabel ? ` [${sessionLabel}]` : '';
  const header = separator(`── POST${sessionPart} ── ${time} `);

  if (sessionLabel) {
    const sColor = sessionColor(sessionLabel);
    const colored = header.replace(
      `[${sessionLabel}]`,
      `${sColor}[${sessionLabel}]${color + BOLD}`,
    );
    writeln(color + BOLD + colored + RESET);
  } else {
    writeln(color + BOLD + header + RESET);
  }

  const lines = renderAdvisoryLines(content);
  for (const line of lines) {
    writeln(line);
  }

  writeln(DIM + separator() + RESET);
}

/**
 * Print a post-advisory "aligned" one-liner — dim, colored with the session's
 * color when a label is present, otherwise dim green.
 *
 * Example:
 *   ── POST ── 14:25:38 ── ✓ Aligned ──────────────────────────────────────────
 *   ── POST [S1] ── 14:25:38 ── ✓ Aligned ──────────────────────────────────────
 */
export function printPostAligned(_summary: string, sessionLabel?: string, score?: number): void {
  const time = formatTime(new Date());
  const sessionPart = sessionLabel ? ` [${sessionLabel}]` : '';
  const scorePart = score !== undefined ? ` ── score: ${score.toFixed(2)}` : '';
  const prefix = `── POST${sessionPart} ── ${time}${scorePart} ── ✓ Aligned `;
  const color = sessionLabel ? sessionColor(sessionLabel) : GREEN;
  writeln(DIM + color + separator(prefix) + RESET);
}

/**
 * Print a post-advisory "misaligned" box with a red header.
 * The [Sn] tag is colored with the session's color.
 *
 * Example:
 *   ── POST ── 14:31:02 ────────────────────────────────
 *   ── POST [S1] ── 14:31:02 ────────────────────────────────
 */
export function printPostMisaligned(advisory: string, sessionLabel?: string): void {
  printPost(RED, advisory, sessionLabel);
}

/**
 * Print a dim session-connected line colored with the session's color.
 *
 * Example:
 *   ── S1 connected (abcd1234…) ── 14:23:07
 */
export function printSessionStart(label: string, sessionId: string): void {
  const time = formatTime(new Date());
  const shortId = sessionId.slice(0, 8);
  writeln(DIM + sessionColor(label) + `── ${label} connected (${shortId}…) ── ${time}` + RESET);
}

/**
 * Print a suppressed-events counter line — dim one-liner shown before an alert
 * when running in alert-only mode (the default).
 *
 * Example:
 *   ... 23 events clear ...
 *   ... 1 event clear ...
 */
export function printSuppressedCount(count: number): void {
  writeln(DIM + `  ... ${count} event${count === 1 ? '' : 's'} clear ...` + RESET);
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

/**
 * Print a debug trace line — dim, prefixed with [dbg].
 * An optional multi-line body is indented under the label.
 *
 * Example (label only):
 *   [dbg] PRE triggered — promptId=abc123  session=S1
 *
 * Example (with body):
 *   [dbg] CLASSIFIER input
 *        User prompt to classify:
 *        commit the changes
 */
export function printDebug(label: string, body?: string): void {
  const INDENT = '     '; // aligns body under '[dbg] '
  if (body) {
    const indented = body.split('\n').map((l) => INDENT + l).join('\n');
    writeln(DIM + '[dbg] ' + label + '\n' + indented + RESET);
  } else {
    writeln(DIM + '[dbg] ' + label + RESET);
  }
}
