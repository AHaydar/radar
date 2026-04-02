# radar-cc

Intent alignment checker for Claude Code. Radar watches Claude Code's OpenTelemetry stream and tells you — in a second terminal pane — whether your prompt was clear before Claude starts, and whether Claude stayed on target after it finishes.

## Requirements

- Node.js >= 22
- An Anthropic API key

## Install

```sh
npm install -g radar-cc
radar setup
```

`radar setup` writes the required OTel environment variables to `~/.claude/settings.json` and walks you through storing your Anthropic API key — either on local disk or in 1Password. Restart Claude Code after running it.

You can also pass the key directly to skip the prompt:

```sh
radar setup --api-key <your-key>
```

## Usage

Open a second terminal pane alongside Claude Code and run:

```sh
radar watch
```

Send prompts in your Claude Code pane as normal. Radar listens passively on `localhost:4820`.

## Output

```
── Radar v0.1.0 ─────────────────────────────────────
Listening on localhost:4820
Waiting for Claude Code telemetry...
─────────────────────────────────────────────────────

── PRE ── 14:23:07 ── score: 0.34 ── ✓ Clear ────────

── PRE ── 14:25:12 ── score: 0.78 ───────────────────
⚠ "clean up this module" is ambiguous.
  Claude will likely restructure imports and rename functions.
  Did you mean: remove the 3 commented-out functions?
  → Try: "delete the dead code in auth.ts — the 3 commented
    functions at the bottom"
─────────────────────────────────────────────────────

── POST ── 14:25:38 ──────────────────────────────────
✓ Response aligned with intent.
  Tools: Edit (2 files) · 847 tokens · $0.003
─────────────────────────────────────────────────────

── POST ── 14:31:02 ──────────────────────────────────
✗ Scope exceeded likely intent.
  Claude ran Edit on 5 files, Bash (3 commands), 12k tokens, $0.08.
  Developer likely wanted: coverage for 2 new edge cases only.
  → "undo all changes. add test cases for the null input
    and timeout edge cases in processOrder — nothing else"
─────────────────────────────────────────────────────
```

PRE advisories fire within ~2 seconds of your prompt. POST advisories fire after Claude's turn ends, based on what tools it used and what it changed — not Claude's response text, which OTel does not expose.

## How it works

Claude Code emits structured OTel log events (`user_prompt`, `tool_result`, `api_request`) when telemetry is enabled. Radar runs a lightweight OTLP HTTP receiver on `localhost:4820` that collects these events without touching Claude's execution path.

- **Pre-advisory:** Haiku scores the prompt for ambiguity. If the score is >= 0.6, Sonnet prints a warning with the most likely misinterpretation and a suggested clarification.
- **Post-advisory:** After no new events for ~5 seconds (turn boundary), Sonnet reviews the accumulated tool activity against the original prompt intent and flags scope drift.

Claude is never blocked or interrupted.

## OTel variables (set by `radar setup`)

| Variable | Value |
|---|---|
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `1` |
| `OTEL_LOGS_EXPORTER` | `otlp` |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/json` |
| `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` | `http://localhost:4820/v1/logs` |
| `OTEL_LOG_USER_PROMPTS` | `1` |
| `OTEL_LOG_TOOL_DETAILS` | `1` |
| `OTEL_LOGS_EXPORT_INTERVAL` | `2000` |

`OTEL_LOG_USER_PROMPTS=1` is required for prompt content analysis. Without it, Radar can detect turn boundaries but cannot analyze intent.

These are written to the `env` block in `~/.claude/settings.json`. If Radar is not running, Claude Code silently ignores them.

## Options

```
radar setup [options]

  -k, --api-key <key>       API key to store (skips the interactive prompt)

radar watch [options]

  -p, --port <number>       OTLP listener port (default: 4820)
  -t, --timeout <ms>        Turn boundary silence window (default: 5000)
  -s, --threshold <score>   Ambiguity score threshold 0.0–1.0 (default: 0.6)
  -k, --api-key <key>       Anthropic API key (overrides all stored sources)
```

## License

MIT
