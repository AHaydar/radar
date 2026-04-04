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

PRE advisories fire within ~2 seconds of your prompt. POST advisories fire after Claude's turn ends, based on tool activity, cost, and a Haiku-generated summary of Claude's actual response text.

## How it works

Claude Code emits structured OTel log events (`user_prompt`, `tool_result`, `api_request`) when telemetry is enabled. Radar runs a lightweight OTLP HTTP receiver on `localhost:4820` that collects these events without touching Claude's execution path.

- **Pre-advisory:** Haiku scores the prompt for ambiguity. If the score is >= 0.6, Sonnet prints a warning with the most likely misinterpretation and a suggested clarification.
- **Post-advisory:** After the turn ends, Haiku summarises Claude's actual response text from the JSONL transcript. Sonnet then reviews tool activity, cost, and the response summary against the original intent and flags scope drift or misalignment.

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

## Developing locally

### Switch from the global install to a local build

1. Uninstall the global package:
   ```sh
   npm uninstall -g radar-cc
   ```
2. Install dependencies and build:
   ```sh
   npm install
   npm run build
   ```
3. Link the local build as the global `radar` binary:
   ```sh
   npm link
   ```
   From now on, `radar` points to `dist/cli/index.js` in this repo. Re-run `npm run build` after any code change — no re-linking needed.

### Run setup and tests

4. Run setup to (re-)install the hook scripts:
   ```sh
   radar setup
   ```
   Confirm you see both of these lines in the output:
   ```
   ✓ Hook script written to ~/.radar/hooks/stop.sh
   ✓ Extract script written to ~/.radar/hooks/extract-response.py
   ```
5. Restart Claude Code so the new Stop hook takes effect.
6. Run the test suite:
   ```sh
   npm test
   ```

### Verify the pipeline end-to-end

7. Check the installed hook version:
   ```sh
   head -2 ~/.radar/hooks/stop.sh
   # should print: # radar-hook-v2
   ```
8. Confirm the extract script is present:
   ```sh
   ls ~/.radar/hooks/extract-response.py
   ```
9. Manually test the extract script against a real transcript:
   ```sh
   # Find a session transcript (created after Claude Code runs with OTel enabled)
   ls ~/.claude/projects/
   python3 ~/.radar/hooks/extract-response.py \
     ~/.claude/projects/<folder>/<session-id>.jsonl
   # Should print a JSON-encoded string of the last assistant response
   ```
10. With `radar watch` running, manually POST a stop payload to confirm the endpoint accepts the new field:
    ```sh
    curl -s -X POST http://localhost:4820/v1/hook/stop \
      -H "Content-Type: application/json" \
      -d '{"sessionId":"test-123","lastAssistantMessage":"I refactored the auth module."}' | cat
    # Should return: {"ok":true}
    ```
11. Send a prompt in Claude Code and watch the `radar watch` pane. The POST advisory should now reflect what Claude actually said, not just which tools it used.

## License

MIT
