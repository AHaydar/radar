# Radar — Architecture & Implementation Plan

---

## Design Decision: Why OTel, Not Hooks

Radar v1 used Claude Code's prompt hooks (`UserPromptSubmit` + `Stop`) to intercept prompts and responses. After two days of testing, this approach proved brittle:

1. **Prompt hooks are synchronous.** Every prompt — including "yes", "continue", "looks good" — blocked while Haiku evaluated. The mechanism was wrong for a problem that affects ~1 in 10 prompts.
2. **LLM-generated JSON is unreliable.** The Stop hook required Haiku to produce valid JSON under tight timeouts. One stray token → error. This is a reliability ceiling, not a prompt engineering problem.
3. **No visibility.** Advisories went to Claude (post-hook feedback) or appeared as block messages (pre-hook). The developer never saw the analysis directly.

Claude Code supports OpenTelemetry (OTel) event export — structured, non-blocking telemetry emitted in the background. This gives us the data we need without the hook machinery.

### Landscape: What Radar Does NOT Do

Observability tools already exist for Claude Code:

- **[Claude Hindsight](https://github.com/Codestz/claude-hindsight)** — JSONL transcript parser, web dashboard, 3D execution graphs, cost tracking, session replay. Rust + React.
- **[TMA1](https://tma1.ai/)** — OTel-based observability, cost/latency monitoring, security anomaly detection, SQL query interface. Single binary.

Radar does not compete with these. It does not track costs, visualize sessions, or provide dashboards. Radar's scope is **intent analysis** — the one thing neither tool does:

| Tool | Question it answers |
|---|---|
| Hindsight | "What happened in this session?" |
| TMA1 | "How much did it cost? Was anything suspicious?" |
| **Radar** | **"Did Claude understand what I meant?"** |

A developer can run all three. They complement, not compete.

---

## Architecture

**Goal:** Non-blocking, real-time ambiguity detection and intent alignment checking for Claude Code prompts, powered by OTel events.

**Deliverable:** npm package `radar-cc` with a `radar watch` CLI command.

---

### Project Structure

```
radar/
├── src/
│   ├── cli/
│   │   ├── index.ts              # CLI entry (commander)
│   │   └── watch.ts              # radar watch — OTLP receiver + analyzer
│   ├── receiver/
│   │   └── otlp.ts               # Lightweight OTLP HTTP server (receives log exports)
│   ├── aggregator/
│   │   └── turn.ts               # Groups events by prompt.id, detects turn boundaries
│   ├── analysis/
│   │   ├── classifier.ts         # Tier 1: Haiku ambiguity scorer
│   │   ├── advisor.ts            # Tier 2: Sonnet advisory (pre + post modes)
│   │   └── prompts.ts            # All LLM prompt templates
│   └── output/
│       └── formatter.ts          # Terminal output — colors, boxes, timestamps
├── package.json
├── tsconfig.json
├── PRD-v1.md
└── ARCHITECTURE.md
```

### How It Works

```
┌──────────────────────┐       OTLP HTTP/JSON        ┌───────────────────┐
│    Claude Code       │ ─────────────────────────── │   radar watch     │
│                      │   user_prompt events         │   (Node.js)       │
│  Env vars:           │   tool_result events         │                   │
│  OTEL_LOGS_EXPORTER  │   api_request events         │  ┌─ OTLP receiver │
│  = otlp              │                              │  ├─ aggregator    │
│  OTEL_LOG_USER_      │                              │  ├─ classifier    │
│  PROMPTS = 1         │                              │  ├─ advisor       │
│                      │                              │  └─ formatter     │
└──────────────────────┘                              └───────────────────┘
        Main pane                                          Radar pane
```

### Event Flow

| Step | Main pane (Claude Code) | Radar pane (`radar watch`) |
|---|---|---|
| 1 | Developer sends prompt | — |
| 2 | Claude Code emits `user_prompt` event via OTLP | OTLP receiver gets event within ~2s |
| 3 | Claude starts processing immediately (never blocked) | Haiku classifier scores prompt ambiguity |
| 4 | Claude calls tools (Edit, Bash, etc.) | If score ≥ 0.6 → Sonnet pre-advisory printed |
| 5 | Claude makes API requests | `tool_result` + `api_request` events accumulate, grouped by `prompt.id` |
| 6 | Claude finishes turn | No new events for ~5s → turn boundary detected |
| 7 | Developer reads response | Post-advisory: Sonnet analyzes accumulated tool activity vs original prompt intent |

### OTel Events Used

Claude Code emits these events when `OTEL_LOGS_EXPORTER=otlp` is configured:

| Event | Key Attributes | Radar Use |
|---|---|---|
| `claude_code.user_prompt` | `prompt` (requires `OTEL_LOG_USER_PROMPTS=1`), `prompt_length`, `prompt.id` | Pre-advisory trigger + input |
| `claude_code.tool_result` | `tool_name`, `success`, `duration_ms`, `tool_parameters` (includes bash commands), `tool_result_size_bytes` | Post-advisory: what Claude *did* |
| `claude_code.api_request` | `model`, `cost_usd`, `input_tokens`, `output_tokens`, `duration_ms` | Post-advisory: cost/effort context |
| `claude_code.api_error` | `error`, `status_code` | Error awareness |

**`prompt.id`** is the critical correlation key — a UUID that links all events from a single user prompt. Every tool call, API request, and error shares the same `prompt.id`.

**What OTel does NOT include:** Claude's response text. We get tool results and metadata, but not `last_assistant_message`. Post-advisory is based on *what Claude did* (tools used, files edited, commands run, tokens spent) rather than *what Claude said*. This is often more actionable.

---

### Setup

Environment variables (can be set in shell profile or `.claude/settings.json` `env` block):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://localhost:4820/v1/logs
export OTEL_LOG_USER_PROMPTS=1
export OTEL_LOG_TOOL_DETAILS=1
export OTEL_LOGS_EXPORT_INTERVAL=2000    # 2s for faster advisories (default: 5s)
```

Usage:

```bash
npm install -g radar-cc
radar watch    # start in a second terminal pane
# then start Claude Code normally — telemetry flows automatically
```

No hooks to merge, no settings.json hook modifications, no plugin system required.

---

### Component Design

#### OTLP Receiver (`src/receiver/otlp.ts`)

Lightweight HTTP server on `localhost:4820`.

- Accepts `POST /v1/logs` (OTLP JSON format)
- Parses OTel `LogRecord` objects → extracts event name + attributes
- Emits typed events to the aggregator
- Returns `200 OK` immediately (never blocks Claude Code's export)

Implementation: Node.js built-in `http` module. No OTel SDK dependency needed on the receiver side — we're just parsing JSON.

#### Turn Aggregator (`src/aggregator/turn.ts`)

Groups events by `prompt.id` and detects turn boundaries.

Maintains a `Map<promptId, TurnContext>` where `TurnContext` accumulates:
- The user prompt text (from `user_prompt` event)
- List of tool results: tool name, success, duration, bash command if applicable
- API request summaries: model, cost, tokens
- Any errors

**Turn boundary detection:** No new events for the same `prompt.id` for N seconds (configurable, default 5s) → turn is complete → triggers post-advisory.

**Cleanup:** Removes completed turns after 5 minutes to prevent memory growth.

#### Classifier (`src/analysis/classifier.ts`)

**Model:** Haiku
**Input:** User prompt text (from `user_prompt` event attribute)
**Output:** `{ score: number, reason: string }`
**Timeout:** 3 seconds, fallback to score 0.5
**Cost:** ~$0.001 per call

Same ambiguity detection logic from the hook-based approach — the prompt is proven, only the delivery mechanism changed.

#### Advisor (`src/analysis/advisor.ts`)

**Model:** Sonnet
**Two modes:**

**Pre-advisory** (triggered when classifier score ≥ 0.6):
- Input: user prompt + classifier score + reason
- Output: most likely misinterpretation, scope risk, one clarifying question
- Max 4 lines

**Post-advisory** (triggered on turn boundary):
- Input: user prompt + accumulated `TurnContext` (tools used, files edited, bash commands run, cost, token count)
- Output: alignment assessment. If misaligned: what went wrong + exact re-prompt suggestion
- Max 5 lines

**Timeout:** 10 seconds
**Cost:** ~$0.005–0.01 per call

#### Watch Process (`src/cli/watch.ts`)

Wires everything together. Developer runs `radar watch` in a second terminal.

**Startup:**
1. Start OTLP HTTP server on `localhost:4820`
2. Print status: "Radar listening on :4820 — waiting for Claude Code events..."
3. Warn if first events arrive without prompt content (developer forgot `OTEL_LOG_USER_PROMPTS=1`)

**Event loop:**
1. OTLP receiver parses incoming log exports
2. On `user_prompt` event:
   - Create new `TurnContext` for this `prompt.id`
   - Run classifier (Haiku)
   - If score < 0.6 → print one-line clear message (dim)
   - If score ≥ 0.6 → run advisor (Sonnet) → print full pre-advisory
3. On `tool_result` / `api_request` / `api_error` events:
   - Append to existing `TurnContext` for this `prompt.id`
4. On turn boundary (no new events for N seconds):
   - Run advisor in post mode (Sonnet) with full `TurnContext`
   - Print post-advisory

#### Formatter (`src/output/formatter.ts`)

Terminal output formatting.

```
── PRE ── 14:23:07 ── score: 0.34 ── ✓ Clear ─────

── PRE ── 14:25:12 ── score: 0.78 ─────────────────
⚠ "clean up this module" is ambiguous.
  Claude will likely restructure imports and rename functions.
  Did you mean: remove the 3 commented-out functions?
  → Try: "delete the dead code in auth.ts — the 3 commented
    functions at the bottom"
────────────────────────────────────────────────────

── POST ── 14:25:38 ────────────────────────────────
✓ Response aligned with intent.
  Tools: Edit (2 files) · 847 tokens · $0.003
────────────────────────────────────────────────────

── POST ── 14:31:02 ────────────────────────────────
✗ Scope exceeded likely intent.
  Claude ran Edit on 5 files, Bash (3 commands), 12k tokens, $0.08.
  Developer likely wanted: coverage for 2 new edge cases only.
  → "undo all changes. add test cases for the null input
    and timeout edge cases in processOrder — nothing else"
────────────────────────────────────────────────────
```

**Colours:**
- Green: aligned / clear
- Yellow/amber: pre-warning
- Red: post-mismatch
- Dim grey: suppressed / low-score clears

---

### Model Strategy

| Pre-advisory | Post-advisory |
|---|---|
| Haiku classify → Sonnet advise (when score ≥ 0.6) | Sonnet always (uses accumulated TurnContext) |

---

### Dependencies

| Package | Purpose | Dev/Prod |
|---|---|---|
| `commander` | CLI framework | prod |
| `@anthropic-ai/sdk` | Haiku + Sonnet API calls | prod |
| `typescript` | Type safety | dev |
| `tsup` | Bundling | dev |

No OTel SDK needed. The OTLP receiver is a plain HTTP server parsing JSON — Node.js built-in `http` module is sufficient. Deliberately minimal.

---

### Implementation Order

```
Step 1: Scaffold (package.json, tsconfig, tsup config, CLI skeleton)
        │
        ├── Step 2: OTLP receiver (otlp.ts)
        │           HTTP server, parse LogRecord JSON, emit typed events.
        │           Test: POST sample OTel payload → events emitted correctly.
        │
        ├── Step 3: Turn aggregator (turn.ts)
        │           Group by prompt.id, detect turn boundaries.
        │           Test: feed sequence of events → TurnContext built correctly.
        │
        └── Step 4: Formatter (formatter.ts)
                    Terminal output formatting.
                    Test: format sample advisory → matches expected output.

Step 5: Classifier (classifier.ts)
        Depends on: Anthropic SDK setup.
        Test: known-ambiguous prompts score > 0.6, clear prompts < 0.4.

Step 6: Advisor (advisor.ts, prompts.ts)
        Depends on: Anthropic SDK.
        Post-advisory prompt uses TurnContext (tools, cost, tokens) not last_assistant_message.
        Test: pre-advisory on ambiguous prompt produces actionable output.

Step 7: Watch process (watch.ts)
        Wires: receiver → aggregator → classifier/advisor → formatter.
        Integration: start Claude Code with OTel env vars + radar watch side by side.
```

Steps 2, 3, and 4 can be built in parallel.

---

### Testing Strategy

| Layer | How |
|---|---|
| OTLP receiver | Unit test: POST sample OTel JSON payload, verify events parsed correctly |
| Turn aggregator | Unit test: feed sequence of events with same/different prompt.id, verify grouping and boundary detection |
| Classifier | Integration test: call Haiku with PRD example prompts, assert score ranges |
| Advisor | Integration test: call Sonnet with fixture TurnContext, assert advisory format |
| Formatter | Unit test: format sample advisories, verify output structure and colors |
| Watch process | Manual end-to-end: run Claude Code with OTel env vars + radar watch side by side |

---

### Risks

| Risk | Severity | Mitigation |
|---|---|---|
| OTel export format may change between Claude Code versions | Low | Standard OTLP protocol — unlikely to break. Resilient parser — skip unknown fields |
| `OTEL_LOG_USER_PROMPTS` not enabled — only prompt length, no content | Medium | `radar watch` warns on startup if events arrive without prompt text |
| Export interval adds latency — pre-advisory arrives ~2-5s after prompt, after Claude has started | Low | Advisory-only, not blocking — timing is acceptable. Reduce interval to 2s with `OTEL_LOGS_EXPORT_INTERVAL=2000` |
| No access to Claude's response text — post-advisory based on tool activity only | Medium | Tool activity (files edited, commands run, cost) is often more actionable than response text. Can add optional JSONL reading later if needed |
| Cost creep with Sonnet on every post-advisory | Low | Log cumulative cost in watch output, add threshold flag later |
| Port conflict on 4820 | Low | Make port configurable via `--port` flag |

---

### Prompt Tuning

The ambiguity detection and alignment prompts carry forward from the hook-based approach. Key tuning dimensions:

- **Sensitivity:** "Be conservative" controls false positive rate. Adjust confidence threshold (currently >70%) based on real usage.
- **Output format:** The advisory is all the developer sees. Keep it tight: warning + suggested clarification.
- **Post-advisory context:** Now includes tool activity data. Tune the prompt to reference specific tools and costs, not just abstract alignment.
- **Scope creep detection:** The most common failure mode. Consider adding explicit examples to the prompt.

---

### Future Roadmap

| Version | Scope |
|---|---|
| v0.1 | OTLP receiver + classifier + advisor + formatter (the watch process) |
| v0.2 | SQLite logging + `radar status` + did-I-act-on-this tracking |
| v0.3 | Pattern detection across sessions → personalised CLAUDE.md suggestions |
| v0.4 | Optional JSONL transcript reading for deeper post-advisory (Claude's response text) |
| v1.0 | Team opt-in: anonymised signal aggregation for platform lead visibility |
