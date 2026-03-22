# Radar

A Claude Code sidecar that flags ambiguous prompts and checks whether Claude's actions matched your intent — displayed in a second terminal pane.

---

## The problem

Claude Code's responses are only as good as the developer's intent, but intent is not often communicated precisely.

| You say | Claude does | You meant |
|---|---|---|
| "clean up this module" | Restructures imports, renames functions, splits files | Delete the 3 commented-out functions |
| "the API is slow" | Adds Redis caching across 4 endpoints | Profile this one DB query |
| "update the tests" | Rewrites the entire test suite | Add coverage for 2 new edge cases |


Radar analyses at two moments: early in Claude's turn (pre-advisory, based on prompt text) and after Claude finishes (post-advisory, based on what tools Claude used and what it changed).
There's a limitiation in the current version: Sonnet is inferring intent alignment from side effects without seeing Claude's actual response. It knows Claude touched 5 files but not why Claude explained it did so. That's a reasonable proxy most of the time — scope creep and wrong-target are visible in tool activity — but it'll miss subtler misalignments where Claude did the right amount of work on the wrong thing within the same. The reason for that is that the OTel events Claude Code emits are operational telemetry — user_prompt, tool_result, api_request, api_error. They tell you what happened mechanically. The actual assistant message (what Claude wrote back to the developer) isn't an OTel event. In a future version we can fix that subtlety through parsing the jsonl files.


---

## Installation

The package isn't published to npm yet. To install locally from the repo:

```bash
git clone https://github.com/ahaydar/radar.git
cd radar
npm install
npm run build
npm link
```

Add the OTel env vars to your shell profile:

```bash
cat >> ~/.zshrc << 'EOF'

# Radar: Claude Code OTel config
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4820/v1/logs
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_LOGS_EXPORT_INTERVAL=2000
EOF
source ~/.zshrc
```

Replace `~/.zshrc` with `~/.bashrc` if using Bash. These are safe to have permanently — if Radar isn't running, Claude Code silently ignores them.

## Usage

Radar requires an Anthropic API key. Set it in your environment:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Or pass it directly:

```bash
radar watch --api-key sk-ant-...
```

In one terminal pane, start Radar:

```bash
radar watch
```

In another pane, start Claude Code normally. Telemetry flows automatically.

Claude Code must be started (or restarted) after the env vars are set — it reads them at launch.

### Dev mode

`npm run dev` compiles TypeScript in watch mode and simultaneously runs `radar watch`, restarting it whenever the build changes:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm run dev
```

---

## How it works

**Pre-advisory:** When you submit a prompt, Claude Code emits it via OTel. Radar's Haiku classifier scores its ambiguity. If risk is high, Sonnet prints a warning in the Radar pane — what Claude will likely misinterpret and how to rephrase. Claude is already working at this point; you can hit Esc to interrupt if the warning is serious.

**Post-advisory:** After Claude's turn ends (no new tool calls for ~5s), Sonnet reviews the accumulated activity — tools called, files edited, commands run, tokens spent — and checks whether it matched your likely intent. If misaligned, it prints a suggested re-prompt.

Radar stays silent when everything looks clear.

---

## Tuning

Prompt templates are in `src/analysis/prompts.ts`. Key tuning dimensions:

- **Sensitivity:** Classifier flags prompts above a 0.6 ambiguity score. Raise to 0.7 if too noisy; lower to 0.5 if missing obvious cases.
- **Post-advisory context:** The advisor sees tool activity (files, commands, cost) but not Claude's response text. Tune the prompt to reference specific tools and costs.
