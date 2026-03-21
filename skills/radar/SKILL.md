# Radar

Radar is a Claude Code plugin that detects ambiguous prompts before Claude misinterprets them, and checks that Claude's responses matched your intent after the fact.

---

## What it does

**Pre-advisory (before Claude runs):**
When you submit a prompt, Radar's pre-hook evaluates it for ambiguity. If your prompt is likely to be misinterpreted, the hook blocks the submission and tells you why — so you can rephrase before Claude starts.

Example block reason:
> "Claude will likely restructure the entire module rather than remove dead code. Try: 'delete the 3 commented-out functions at the bottom of auth.ts — nothing else'."

**Post-advisory (after Claude responds):**
When Claude finishes, Radar's post-hook checks whether the response matched your likely intent. If the response is misaligned (scope exceeded, wrong target, etc.), the hook feeds the feedback back to Claude so it can self-correct.

---

## When Radar fires

| Event | When | Action |
|---|---|---|
| Pre-advisory | You press enter on a prompt | Blocks + shows reason if ambiguous (>70% confidence) |
| Post-advisory | Claude finishes its full response | Feeds misalignment reason back to Claude if detected |

Radar stays silent when prompts are clear and responses are aligned. It only intervenes when the risk of misinterpretation is high.

---

## Understanding a warning

When Radar blocks a prompt, the block reason has two parts:

1. **The likely misinterpretation** — what Claude would probably do with your current phrasing
2. **A suggested rephrasing** — a more specific version that removes the ambiguity

You can accept the suggestion, write your own, or dismiss it and proceed anyway (just resubmit the same prompt — Radar won't block twice on the same text).

---

## Tuning sensitivity

The default sensitivity flags prompts where Radar is >70% confident Claude will misinterpret. This is intentionally conservative to avoid noise.

If Radar is flagging too many prompts, the threshold in `hooks/hooks.json` can be raised:
- Change `>70% confident` to `>80% confident` in the UserPromptSubmit prompt text

If Radar is missing obvious ambiguities, lower it:
- Change to `>60% confident`

---

## Questions?

If Radar triggered and you're not sure why, ask: *"Why did Radar flag my last prompt?"* — Claude will explain based on the ambiguity criteria above.
