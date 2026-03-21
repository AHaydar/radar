# Radar

A Claude Code plugin that catches ambiguous prompts before Claude misinterprets them — and checks that responses matched your intent after the fact.

---

## The problem

Claude Code's responses are only as good as the developer's intent — but intent is rarely communicated precisely.

| You say | Claude does | You meant |
|---|---|---|
| "clean up this module" | Restructures imports, renames functions, splits files | Delete the 3 commented-out functions |
| "the API is slow" | Adds Redis caching across 4 endpoints | Profile this one DB query |
| "update the tests" | Rewrites the entire test suite | Add coverage for 2 new edge cases |

Radar intervenes at two moments: before Claude starts (pre-advisory) and after Claude responds (post-advisory).

---

## Installation

```bash
# Add the marketplace catalog
/plugin marketplace add /path/to/radar     # local
/plugin marketplace add ahaydar/radar      # from GitHub

# Install the plugin
/plugin install radar@radar

# Uninstall
/plugin uninstall radar@radar
```
---

## How it works

**Pre-advisory (`UserPromptSubmit`):**
When you submit a prompt, a Haiku classifier scores its ambiguity. If the risk is high, the hook blocks and shows you why — you can rephrase before Claude starts.

**Post-advisory (`Stop`):**
After Claude finishes, a Haiku evaluator checks whether the response matched your likely intent. If misaligned, it feeds the correction back to Claude.

Radar stays silent when everything looks clear.

---

## Phase 1 limitations

This is Radar Lite — zero infrastructure, prompt hooks only. Known trade-offs:

- Post-advisory feedback goes to Claude (not directly to you)
- Both hooks are synchronous (~200ms Haiku pause)
- No separate pane for advisory output
- Pre-hook has no prior session context

Phase 2 (Radar Full) solves these with async command hooks and a dedicated `radar watch` pane.

---

## Tuning

Prompts are in `hooks/hooks.json`. Key tuning dimensions:

- **Sensitivity:** Default is `>70% confident`. Raise to `>80%` if too noisy; lower to `>60%` if missing obvious cases.
- **Reason format:** The `reason` string is what the developer sees. Keep it tight: misinterpretation risk + suggested rephrasing.

See [ARCHITECTURE.md](ARCHITECTURE.md) section 1.6 for full tuning guidance.
