# Radar — Architecture & Implementation Plan

---

## Phase 1: Radar Lite

**Goal:** Validate that ambiguity detection prompts work. Ship in one session. Zero infrastructure.

**Deliverable:** A Claude Code plugin — installable from a git repo.

---

### 1.1 Plugin Structure

```
radar/
├── .claude-plugin/
│   ├── plugin.json          # Plugin metadata (name, version, description)
│   └── marketplace.json     # Marketplace catalog — registers this repo as a plugin source
├── hooks/
│   └── hooks.json           # Hook definitions — auto-registered by Claude Code on install
├── skills/
│   └── radar/
│       └── SKILL.md         # User-facing skill — explains warnings, tuning
├── README.md
├── PRD-v1.md
└── ARCHITECTURE.md
```

**`.claude-plugin/plugin.json`** — Declares the plugin to Claude Code. Name, version, author, keywords. No runtime code.

**`.claude-plugin/marketplace.json`** — Marketplace catalog that registers this repo as a plugin source. Required for `/plugin marketplace add` to work. Lists the `radar` plugin with its source path, description, and metadata.

**`hooks/hooks.json`** — Contains the two prompt hooks (UserPromptSubmit + Stop). Claude Code registers these automatically when the plugin is installed. The developer never edits their `settings.json` directly.

**`skills/radar/SKILL.md`** — Exposes a `/radar` skill to the user. When the developer asks about a warning or wants to understand what Radar does, Claude reads this file.

### 1.2 Installation

```bash
# Add the marketplace (registers the catalog)
/plugin marketplace add /path/to/radar    # local
/plugin marketplace add ahaydar/radar     # from GitHub

# Install the plugin
/plugin install radar@radar

# Uninstall
/plugin uninstall radar@radar
```

No npm package, no build step, no API key setup. The plugin system handles hook registration.

### 1.3 Hook Configuration

Defined in `hooks/hooks.json` (not the user's settings.json):

- **UserPromptSubmit:** `prompt` hook, model `"haiku"`, 10s timeout — scores ambiguity, blocks if risky
- **Stop:** `prompt` hook, model `"haiku"`, 15s timeout — checks response alignment, blocks if misaligned

Model aliases like `"haiku"` are preferred — they automatically resolve to the latest version.

**Output format (per Claude Code hook protocol):**
- **Allow (proceed):** Return empty JSON `{}` or no output. Claude proceeds normally.
- **Block (with feedback):** Return `{ "decision": "block", "reason": "..." }`. The reason is shown to the developer (pre) or fed back to Claude (post).

**Constraint:** Prompt hooks are synchronous by design — they cannot use `"async": true` (only command hooks support that). Every prompt submission and stop event blocks until Haiku responds. Haiku typically responds in <1s; the 10-15s timeouts are safety bounds.

See `hooks/hooks.json` for the full prompt text.

### 1.4 How It Works

**Pre-advisory (UserPromptSubmit):**
1. Developer types a prompt and hits enter
2. Claude Code fires the prompt hook. `$ARGUMENTS` contains:
   ```json
   {
     "session_id": "...",
     "transcript_path": "/path/to/session.jsonl",
     "cwd": "/Users/.../project",
     "hook_event_name": "UserPromptSubmit",
     "prompt": "clean up this module"
   }
   ```
3. Haiku evaluates ambiguity risk
4. If low risk → returns `{}` → Claude proceeds normally, developer notices nothing
5. If high risk → returns `{ "decision": "block", "reason": "..." }` → Developer sees the reason as a block message. They can rephrase and resubmit.

**Post-advisory (Stop):**
1. Claude finishes its full response (all tool calls complete)
2. Claude Code fires the prompt hook. `$ARGUMENTS` contains:
   ```json
   {
     "session_id": "...",
     "transcript_path": "/path/to/session.jsonl",
     "cwd": "/Users/.../project",
     "hook_event_name": "Stop",
     "stop_hook_active": false,
     "last_assistant_message": "I've completed the refactoring..."
   }
   ```
3. Haiku evaluates whether the response (`last_assistant_message`) matched the developer's likely intent
4. If `stop_hook_active` is `true` → returns `{}` immediately (prevents infinite loops)
5. If aligned → returns `{}` → Turn ends normally
6. If misaligned → returns `{ "decision": "block", "reason": "..." }` → Hook blocks the stop. The reason is fed back to Claude. Claude may self-correct or surface the feedback.

### 1.5 Known Limitations to Observe

Track these during use — they become the requirements for Phase 2:

| # | Limitation | What to watch for |
|---|---|---|
| L1 | Developer doesn't see post-advisory directly | Does Claude surface the feedback? Or does it silently adjust? Is that good or bad? |
| L2 | Prompt hooks are synchronous (hard constraint — cannot be async). Pre-hook blocks Claude on every prompt. | Is the ~200ms Haiku pause noticeable? Does blocking feel helpful or annoying? |
| L3 | Haiku-only (no Sonnet escalation) | Are Haiku's assessments good enough? Where does it miss? |
| L4 | Pre-hook has no prior session context (only the current prompt). Post-hook has `last_assistant_message` but the prompt hook can't read `transcript_path`. | Is current-prompt-only enough for pre-advisory? Is `last_assistant_message` enough for post-advisory, or do we need full session history? |
| L5 | Post-hook may cause loops | Does `stop_hook_active` reliably prevent infinite continues? |
| L6 | No visibility into what Radar flagged | Useful advisories are invisible unless you remember them |

### 1.6 Prompt Tuning

The prompts above are v1. Expect to iterate. Key tuning dimensions:

- **Sensitivity:** "Be conservative" controls false positive rate. If too noisy, add "Only flag if you are >80% confident Claude will misinterpret."
- **Output format:** The `reason` string is all the developer sees. Keep it tight: warning + suggested clarification.
- **Scope creep detection:** The most common failure mode. Consider adding explicit examples to the prompt.

### 1.7 Implementation Steps

| Step | Action | Time | Status |
|---|---|---|---|
| 1 | Create `.claude-plugin/plugin.json` with metadata | 5 min | — |
| 2 | Create `.claude-plugin/marketplace.json` with catalog | 5 min | — |
| 3 | Create `hooks/hooks.json` with prompt hook definitions (including prompt text) | 30 min | — |
| 4 | Create `skills/radar/SKILL.md` with user-facing docs | 15 min | — |
| 5 | Install plugin locally: `/plugin marketplace add` + `/plugin install radar@radar` | 5 min | — |
| 6 | Test with 5 known-ambiguous prompts from the PRD examples | 30 min | — |
| 7 | Test with 5 clear prompts (should NOT trigger) | 15 min | — |
| 8 | Tune prompts based on results | 30 min | — |
| 9 | Use normally for 2-3 sessions, note pain points | 1-2 days | — |
| 10 | Document findings, feeds Phase 2 requirements | 30 min | — |

---

## Phase 2: Radar Full

**Goal:** Separate pane, non-blocking, two-tier model (Haiku → Sonnet), full session context.

**Deliverable:** npm package `radar-cc` with CLI.

---

### 2.1 Project Structure

```
radar/
├── src/
│   ├── cli/
│   │   ├── index.ts              # CLI entry point (commander)
│   │   ├── install.ts            # radar install — writes hooks + validates env
│   │   ├── uninstall.ts          # radar uninstall — removes hooks
│   │   └── watch.ts              # radar watch — long-running observer process
│   ├── hooks/
│   │   ├── pre.ts                # radar hook pre — thin dispatcher
│   │   └── post.ts               # radar hook post — thin dispatcher
│   ├── analysis/
│   │   ├── classifier.ts         # Tier 1: Haiku ambiguity scorer
│   │   ├── advisor.ts            # Tier 2: Sonnet advisory (pre + post modes)
│   │   └── prompts.ts            # All LLM prompt templates
│   ├── context/
│   │   └── reader.ts             # JSONL session reader + truncator
│   └── output/
│       └── formatter.ts          # Terminal output — colors, boxes, timestamps
├── package.json
├── tsconfig.json
├── PRD-v1.md
└── ARCHITECTURE.md
```

### 2.2 Component Design

#### 2.2.1 Hook Dispatchers (`src/hooks/`)

Thin scripts invoked by Claude Code. Their only job: write an event file and exit.

**`radar hook pre`** (called by UserPromptSubmit):
```
stdin → { session_id, transcript_path, cwd, hook_event_name, prompt }
action → write /tmp/radar/events/pre-<timestamp>.json
stdout → nothing
exit   → 0 (always — never block Claude)
```

**`radar hook post`** (called by Stop):
```
stdin → { session_id, transcript_path, cwd, hook_event_name, stop_hook_active, last_assistant_message }
action → if stop_hook_active, exit 0 (prevent loops)
         else write /tmp/radar/events/post-<timestamp>.json
stdout → nothing
exit   → 0 (always)
```

Event file format:
```json
{
  "type": "pre",
  "timestamp": 1710590400000,
  "session_id": "abc123",
  "transcript_path": "/path/to/session.jsonl",
  "cwd": "/Users/ali/workspace/project",
  "prompt": "clean up this module"
}
```

#### 2.2.2 Context Reader (`src/context/`)

Reads and parses the active Claude Code session JSONL.

**Inputs:** `transcript_path` (provided directly by Claude Code in hook input — no need to guess the path)
**Outputs:**
- `getSessionContext(transcriptPath, maxTurns)` → truncated session as string
- `getLatestPrompt(transcriptPath)` → the user's most recent message
- `getLatestResponse(transcriptPath)` → Claude's most recent full response (text + tool calls summarised)

**JSONL location:** Provided via `transcript_path` field in hook input (e.g. `~/.claude/projects/<project-hash>/<session_id>.jsonl`)

**Truncation:** Last 20 turns by default. A turn = user message + assistant response + tool calls.

**Error handling:** Skip unparseable lines. If file not found, return empty context with a warning.

#### 2.2.3 Classifier (`src/analysis/classifier.ts`)

**Model:** Haiku
**Input:** User prompt + last 3 turns of context
**Output:** `{ score: number, reason: string }`
**Timeout:** 3 seconds, fallback to score 0.5
**Cost:** ~$0.001 per call

#### 2.2.4 Advisor (`src/analysis/advisor.ts`)

**Model:** Sonnet
**Two modes:**

Pre-advisory input:
- Full session context (truncated)
- Current user prompt
- Classifier score + reason

Pre-advisory output:
- Most likely misinterpretation
- Scope risk
- One clarifying question
- Max 4 lines

Post-advisory input:
- Full session context (truncated)
- User prompt
- Claude's response summary

Post-advisory output:
- Alignment assessment
- If misaligned: what went wrong + exact re-prompt
- Max 5 lines

**Timeout:** 10 seconds
**Cost:** ~$0.005–0.01 per call

#### 2.2.5 Watch Process (`src/cli/watch.ts`)

Long-running process. Developer runs `radar watch` in a second terminal.

**Event loop:**
1. `fs.watch` on `/tmp/radar/events/`
2. On pre-event:
   - Read event JSON
   - Run classifier (Haiku)
   - If score < 0.6 → print one-line clear message (dim)
   - If score ≥ 0.6 → read session context, run advisor (Sonnet), print full advisory
3. On post-event:
   - Read event JSON
   - Read session JSONL for Claude's response
   - Run advisor in post mode (Sonnet)
   - Print post-advisory
4. Delete processed event files

**Output format:**
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
────────────────────────────────────────────────────

── POST ── 14:31:02 ────────────────────────────────
✗ Scope exceeded likely intent.
  Claude rewrote the entire test suite (142 lines changed).
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

#### 2.2.6 Install CLI (`src/cli/install.ts`)

**`radar install`:**
1. Validate `ANTHROPIC_API_KEY` is set
2. Read existing `~/.claude/settings.json`
3. Merge Radar hook config (preserve existing hooks)
4. Create `/tmp/radar/events/` directory
5. Print: "✓ Hooks installed. Run `radar watch` in a second terminal."

**`radar uninstall`:**
1. Remove Radar hooks from settings.json
2. Clean up `/tmp/radar/`

### 2.3 Hook Configuration (written by `radar install`)

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "radar hook pre",
            "async": true,
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "radar hook post",
            "async": true,
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

### 2.4 Dependencies

| Package | Purpose | Dev/Prod |
|---|---|---|
| `commander` | CLI framework | prod |
| `@anthropic-ai/sdk` | Haiku + Sonnet API calls | prod |
| `typescript` | Type safety | dev |
| `tsup` | Bundling | dev |

No other dependencies. Deliberately minimal.

### 2.5 Implementation Order

```
Step 1: Scaffold (package.json, tsconfig, tsup config, CLI skeleton)
        │
        ├── Step 2: Hook dispatchers (pre.ts, post.ts)
        │           No dependencies. Test: stdin → event file written.
        │
        ├── Step 3: Context reader (reader.ts)
        │           No dependencies. Test: parse sample JSONL → structured output.
        │
        └── Step 4: Install CLI (install.ts)
                    Depends on knowing hook config shape (defined above).
                    Test: settings.json correctly merged.

Step 5: Classifier (classifier.ts)
        Depends on: Anthropic SDK setup
        Test: known-ambiguous prompts score > 0.6, clear prompts < 0.4

Step 6: Advisor (advisor.ts, prompts.ts)
        Depends on: context reader (Step 3), Anthropic SDK
        Test: pre-advisory on ambiguous prompt produces actionable output

Step 7: Watch process (watch.ts, formatter.ts)
        Depends on: all above
        Integration: hooks write events → watch picks up → analysis → formatted output
```

Steps 2, 3, and 4 can be built in parallel.

### 2.6 Testing Strategy

| Layer | How |
|---|---|
| Hook dispatchers | Unit test: mock stdin, verify event file contents |
| Context reader | Unit test: parse fixture JSONL files (capture a real session) |
| Classifier | Integration test: call Haiku with PRD example prompts, assert score ranges |
| Advisor | Integration test: call Sonnet with fixture context, assert advisory format |
| Watch process | Manual end-to-end: run Claude Code + radar watch side by side |

### 2.7 Risks

| Risk | Severity | Mitigation |
|---|---|---|
| JSONL format undocumented, may change | Medium | Resilient parser — skip unknown types, don't crash |
| Event file race conditions | Low | Atomic writes (write .tmp, rename) |
| `fs.watch` unreliable on some OS/FS combos | Medium | Fallback to polling (100ms interval) if watch fails |
| Session JSONL path provided but format undocumented | Medium | `transcript_path` is provided in hook input — no path guessing needed, but JSONL schema may change |
| Cost creep with Sonnet on every post | Low | Log cumulative cost in watch output, add threshold flag later |

---

## Transition: Lite → Full

After 2–3 days of using Lite, document:

1. **Detection quality:** Which prompts did Haiku correctly flag? Which did it miss? Which were false positives?
2. **UX pain points:** Was blocking annoying? Did post-feedback to Claude actually help? Did you want to SEE the advisory?
3. **Context sufficiency:** Was `last_assistant_message` enough for post-analysis, or did you wish Radar had full session history via `transcript_path`?
4. **Prompt iterations:** Final prompt text after tuning — carry these into Full's `prompts.ts`

These findings become the acceptance criteria for Phase 2.
