# Radar
**Product Requirements Document**
Version 5.0 · March 2026 · Individual-first · Pre + Post Advisory
Status: **Draft**

---

## What Changed in v5

| | |
|---|---|
| ADDED | Two-phase delivery: Radar Lite (prompt hooks, zero infrastructure) → Radar Full (command hooks, separate pane) |
| FIXED | Hook types corrected — `UserPromptSubmit` for pre, `Stop` for post (not PreToolUse/PostToolUse) |
| UPDATED | Radar Lite validates detection logic before building infrastructure. Radar Full solves the UX limitations Lite exposes |
| REMOVED | npm package no longer required for Phase 1. Phase 2 introduces it |

---

## Problem

Claude Code's responses are only as good as the developer's intent — but intent is rarely communicated precisely. The failure mode isn't bad prompting, it's ambiguity: Claude interprets a prompt reasonably, executes confidently, and the developer gets a technically correct response to the wrong problem.

The cost is context budget and time — both finite in a session. Once Claude has explored the wrong path, that context is spent.

| Dev says | Claude does | Dev meant |
|---|---|---|
| "the API is slow" | Adds Redis caching across 4 endpoints | Profile this one DB query I already identified |
| "clean up this module" | Restructures imports, renames functions, splits files | Delete the 3 commented-out functions at the bottom |
| "the auth isn't working" | Rewrites token validation logic | The redirect URL is wrong in the OAuth config |
| "update the tests" | Rewrites the entire test suite | Add coverage for two new edge cases only |

`/insights` analyses patterns after the fact — not useful at the moment it matters. There's no feedback loop at prompt-time or immediately after a response.

---

## What Radar Does NOT Solve

> **Limitation:** Radar does not recover context already spent in the current session. If Claude goes down the wrong path, that context is gone. Radar's value is preventing the next mistake — and over time, improving how developers prompt so mistakes happen less frequently.

---

## Solution

Radar is delivered in two phases. Both target the same problem — ambiguity between developer intent and Claude's interpretation — but use different mechanisms.

### Phase 1: Radar Lite (prompt hooks)

Uses Claude Code's built-in `prompt` hook type. Zero infrastructure — just a `settings.json` config. The LLM evaluation runs inside Claude Code itself.

**Pre-advisory (`UserPromptSubmit`):**
Fires when the developer submits a prompt. A Haiku classifier scores ambiguity. If risk is high, the hook blocks with a reason shown to the developer — they can rephrase before Claude starts.

**Post-advisory (`Stop`):**
Fires after Claude finishes responding. A Haiku evaluation compares what Claude did to the developer's likely intent. If misaligned, the hook blocks Claude from stopping and feeds back a correction — Claude self-corrects or the developer sees the feedback.

> **Value of Lite:** Validates whether the ambiguity detection prompts actually work. Identifies the UX pain points that justify building full infrastructure. Ships in hours, not days.

**Known limitations of Lite (to be validated):**
- Advisory feedback goes to Claude, not directly to the developer
- Hooks block Claude while the LLM evaluates (~200ms Haiku, but still synchronous)
- No separate pane — developer doesn't see the advisory unless Claude surfaces it
- Limited to Haiku (Sonnet would be too slow as a blocking hook)
- No two-tier escalation (Haiku classify → Sonnet advise)

### Phase 2: Radar Full (command hooks + watch process)

Solves the limitations exposed by Lite. Uses `command` hooks with `async: true` to dispatch events to a separate `radar watch` process running in a second terminal pane.

**Pre-advisory (`UserPromptSubmit`):**
Fires when the developer submits a prompt. Hook writes an event file and exits immediately — Claude is never blocked. The watch process picks up the event, runs Haiku classification, and if score ≥ 0.6, escalates to Sonnet for a full advisory. Output appears in the radar pane.

**Post-advisory (`Stop`):**
Fires after Claude finishes responding. Hook writes an event file and exits immediately. The watch process reads the session JSONL to get Claude's full response, runs Sonnet to compare intent vs output, and prints the advisory.

> **Value of Full:** Developer sees advisories directly in a dedicated pane. Non-blocking. Two-tier model (Haiku → Sonnet). Full session context analysis.

---

## Architecture

### Hook Events

| Event | When it fires | What it receives |
|---|---|---|
| `UserPromptSubmit` | Developer presses enter | `{ session_id, cwd, prompt }` |
| `Stop` | Claude finishes entire turn | `{ session_id, cwd, stop_hook_active, last_assistant_message }` |

### Phase 1 Flow (Lite)

| | Main window |
|---|---|
| 1 | Dev sends prompt |
| 2 | `UserPromptSubmit` prompt hook fires — Haiku evaluates ambiguity |
| 3 | If high risk: hook returns `{ ok: false, reason: "..." }` — developer sees block reason, can rephrase |
| 4 | If low risk: hook returns `{ ok: true }` — Claude proceeds |
| 5 | Claude processes and responds |
| 6 | `Stop` prompt hook fires — Haiku evaluates response alignment |
| 7 | If misaligned: hook returns `{ ok: false, reason: "..." }` — Claude receives feedback |
| 8 | If aligned: hook returns `{ ok: true }` — turn ends normally |

### Phase 2 Flow (Full)

| | Main window | Radar pane |
|---|---|---|
| 1 | Dev sends prompt | `UserPromptSubmit` command hook fires (async) |
| 2 | Claude processes immediately | Hook writes event to `/tmp/radar/events/` |
| 3 | Claude streams response | Watch process: Haiku scores → Sonnet if ≥ 0.6 |
| 4 | Claude finishes responding | PRE advisory appears (or suppressed if clear) |
| 5 | Dev reads Claude's response | `Stop` command hook fires (async) |
| 6 | Dev decides next action | Watch process: reads JSONL, Sonnet compares intent → POST advisory |

### Full Context = Active Session JSONL (Phase 2 only)

Both hooks read `~/.claude/projects/<project>/<session>.jsonl` — every message, tool call, and result so far.

> **Why full context:** Without it, Sonnet is pattern-matching on the prompt alone. With it, Sonnet understands what's already been done, what Claude's current interpretation is, and where the gap between intent and execution lies.

### Model Strategy

| Phase | Pre-advisory | Post-advisory |
|---|---|---|
| Lite | Haiku (only option — must be fast, blocking) | Haiku (only option — must be fast, blocking) |
| Full | Haiku classify → Sonnet advise (when score ≥ 0.6) | Sonnet always |

---

## Installation

### Phase 1 (Lite) — settings.json only

```bash
# Manual: add hooks to ~/.claude/settings.json or .claude/settings.json
# No npm package, no install command, no dependencies
```

### Phase 2 (Full) — npm package

```bash
npm install -g radar-cc
radar install   # writes hooks to settings.json, creates event directory
radar watch     # run in second terminal pane
```

---

## Tech Stack

| Component | Phase 1 (Lite) | Phase 2 (Full) |
|---|---|---|
| Delivery | settings.json config | npm package (radar-cc) |
| Hook type | `prompt` | `command` (async) |
| Hook events | `UserPromptSubmit` + `Stop` | `UserPromptSubmit` + `Stop` |
| Runtime | Claude Code built-in | Node.js |
| Context | `$ARGUMENTS` only | Full session JSONL |
| Tier 1 | Haiku | Haiku |
| Tier 2 | N/A | Sonnet |
| Output | Inline (block reason / Claude feedback) | Separate terminal pane |
| Storage | None | None (SQLite in v0.3+) |

---

## Phased Roadmap

| Phase | When | Scope |
|---|---|---|
| Lite | Week 1 | Prompt hooks in settings.json — validate detection prompts |
| Full MVP | Week 2–3 | npm package + command hooks + watch process + separate pane |
| v0.2 | Week 4–5 | SQLite logging + `radar status` + did-I-act-on-this tracking |
| v0.3 | Week 6–7 | Pattern detection across sessions → personalised CLAUDE.md suggestions |
| v1.0 | Week 8+ | Team opt-in: anonymised signal aggregation for platform lead visibility |

---

## Reliability Considerations

| Risk | Mitigation |
|---|---|
| Lite pre-hook blocks Claude on every prompt | Haiku is ~200ms — acceptable. Monitor for slower responses |
| Lite post-hook creates infinite loop (Stop blocked → Claude continues → Stop fires again) | Check `stop_hook_active` flag — if true, return `{ ok: true }` |
| Full: advisory arrives after dev has already acted | Post-advisory still valuable — tells dev exactly how to re-prompt |
| Too many false positives → ignored | Pre suppressed below 0.6 (Full); prompt tuned to only flag genuine risk (Lite) |
| JSONL not flushed when hook fires (Full) | 200ms read delay; falls back to last N messages |
| Context too large (Full) | Truncate to last 20 turns |
| API cost | Lite: ~$0.001/prompt (Haiku only). Full: ~$0.003/prompt average |

---

## Open Questions

- **Lite → Full trigger:** What specific pain points in Lite justify building Full? Document them as they emerge.
- Should post-advisory fire on every response, or only when a mismatch is detected above a threshold?
- At what point does post-advisory logging become a personal coaching tool vs noise?
- Does the `Stop` hook's `last_assistant_message` field contain enough context for post-analysis, or do we need full JSONL?
