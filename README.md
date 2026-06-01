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

`radar setup` writes the required OTel environment variables to `~/.claude/settings.json`, installs the Stop hook, and walks you through storing your Anthropic API key — either on local disk or in 1Password. Restart Claude Code after running it.

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

### Dashboard mode

Press **Ctrl-G** at any time to switch to the TUI dashboard, which shows a live session table and per-turn pre/post results. Press `q` or Ctrl-G again to return to scroll view.

You can also start directly in dashboard mode:

```sh
radar watch --ui=dashboard
```

Dashboard controls:

| Key | Action |
|---|---|
| `↑` / `↓` | Move focus between sessions |
| `←` / `→` | Scroll through turns for the focused session |
| `Enter` | Expand / collapse the focused turn |
| `c` | Copy focused turn's advisory to clipboard |
| `q` / Ctrl-G | Exit dashboard, restore scroll view |
| `1`–`9` | Jump directly to session by number |

## Output

### Scroll mode

```
── Radar v0.1.6 ─────────────────────────────────────
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

PRE advisories fire within ~2 seconds of your prompt. POST advisories fire after Claude's turn ends, based on tool activity, cost, and Claude's actual response text.

## How it works

**Setup:** `radar setup` writes OTel env vars to `~/.claude/settings.json` and installs two hook scripts:

- **Stop hook** (`~/.radar/hooks/stop.sh`) — fires after every Claude turn; reads the session transcript to extract the last assistant response and POSTs it to Radar
- **SessionStart hook** (`~/.radar/hooks/session-start.sh`) — fires on first tool use; registers the session with Radar

**When you submit a prompt:**

1. Claude Code emits a `user_prompt` OTel event → Radar opens a new turn context
2. Radar immediately calls Haiku to score ambiguity (0–1)
3. Score < 0.6 → suppress (one-liner in verbose mode). Score ≥ 0.6 → call Sonnet to generate a warning, print yellow pre-advisory
4. Meanwhile, Claude Code runs — `tool_result` and `api_request` OTel events accumulate on the turn context

**When Claude finishes:**

5. The Stop hook fires, extracts the last assistant response from the JSONL transcript, and POSTs `{ sessionId, lastAssistantMessage }` to Radar
6. Radar waits 3.5s for straggling OTel events, then closes the turn
7. Score < 0.6 → skip post-advisory entirely (no further API calls)
8. Score ≥ 0.6 → call Sonnet to judge whether Claude stayed on target, using the accumulated tool activity and assistant response text
9. Aligned → dim one-liner (suppressed in alert-only mode). Misaligned → red box with a re-prompt suggestion
10. Full turn written to `~/.config/radar/history/YYYY-MM-DD.jsonl`

**Context:** the classifier receives the last 3 completed turns as context, so follow-up prompts like "do the same for the tests" score correctly rather than looking vague in isolation.

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

## Options

```
radar setup [options]

  -k, --api-key <key>           API key to store (skips the interactive prompt)

radar watch [options]

  -p, --port <number>           OTLP listener port (default: 4820)
  -s, --threshold <score>       Ambiguity score threshold for pre-advisory, 0.0–1.0 (default: 0.6)
      --post-threshold <score>  Threshold for post-advisory (defaults to --threshold)
      --ui <mode>               Output mode: scroll (default), dashboard, auto
  -v, --verbose                 Show all events including clear/aligned (default: alert-only)
  -d, --debug                   Print internal pipeline trace
  -k, --api-key <key>           Anthropic API key (overrides all stored sources)
```

## Agent name surfacing

When running multiple Claude Code instances (e.g. a FleetView multi-agent setup), you can label each session by exporting env vars before launching Claude:

```sh
export CLAUDE_AGENT_NAME=oracle
export CLAUDE_AGENT_DISPLAY_NAME=Oracle
claude  # this session appears as "Oracle" in the dashboard
```

Without these vars, sessions are labelled `S1`, `S2`, etc.

## Developing locally

1. Build and link the local binary:
   ```sh
   npm install
   npm run build
   npm link
   ```
   From now on, `radar` points to `dist/cli/index.js`. Re-run `npm run build` after code changes — no re-linking needed.

2. Re-run setup to install updated hook scripts:
   ```sh
   radar setup
   ```

3. Restart Claude Code so the new hooks take effect.

4. Run the test suite:
   ```sh
   npm test
   ```

5. To smoke test the full pipeline, build and install globally:
   ```sh
   npm run build && npm install -g .
   radar --version
   ```
   See `SMOKE-TEST.md` for the full checklist.

## License

MIT
