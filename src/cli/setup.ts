import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import {
  readConfig,
  writeConfig,
  configPath,
  isOpAvailable,
  createOpItem,
} from './config.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const RADAR_HOOKS_DIR = join(homedir(), '.radar', 'hooks');
const STOP_HOOK_PATH = join(RADAR_HOOKS_DIR, 'stop.sh');
const EXTRACT_SCRIPT_PATH = join(RADAR_HOOKS_DIR, 'extract-response.py');

const OTEL_VARS: Record<string, string> = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:4820/v1/logs',
  OTEL_LOG_USER_PROMPTS: '1',
  OTEL_LOG_TOOL_DETAILS: '1',
  OTEL_LOGS_EXPORT_INTERVAL: '2000',
};

// ─── ANSI helpers (self-contained, no formatter dependency) ──────────────────

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

const LINE_WIDTH = 52;

function sep(prefix = ''): string {
  return prefix + '─'.repeat(Math.max(0, LINE_WIDTH - prefix.length));
}

function writeln(text = ''): void {
  process.stdout.write(text + '\n');
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

function readSettings(): Record<string, unknown> {
  if (!existsSync(SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse ${SETTINGS_PATH}. Fix the JSON syntax and try again.`);
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

// ─── readline helper ──────────────────────────────────────────────────────────

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// ─── Stop hook installation ───────────────────────────────────────────────────

const STOP_HOOK_SCRIPT = `#!/bin/bash
# radar-hook-v2
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null)

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

# Brief pause to let Claude Code flush the JSONL transcript
sleep 0.2

# Locate the transcript file
TRANSCRIPT=$(find ~/.claude/projects -name "\${SESSION_ID}.jsonl" -type f 2>/dev/null | head -1)

# Extract last assistant response (empty string if not found)
RESPONSE=""
if [ -n "$TRANSCRIPT" ]; then
  RESPONSE=$(python3 ~/.radar/hooks/extract-response.py "$TRANSCRIPT" 2>/dev/null)
fi

# POST to radar (fire and forget)
python3 -c "
import sys, json, urllib.request
payload = json.dumps({
    'sessionId': '$SESSION_ID',
    'lastAssistantMessage': json.loads(sys.argv[1]) if sys.argv[1] else ''
})
req = urllib.request.Request(
    'http://localhost:\${RADAR_PORT:-4820}/v1/hook/stop',
    data=payload.encode(),
    headers={'Content-Type': 'application/json'},
    method='POST'
)
try:
    urllib.request.urlopen(req, timeout=2)
except:
    pass
" "$RESPONSE" &>/dev/null &
`;

const EXTRACT_SCRIPT_CONTENT = `import sys, json

transcript = sys.argv[1]
texts = []

with open(transcript) as f:
    lines = f.readlines()

for line in reversed(lines):
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        continue
    if obj.get('type') == 'user':
        break
    if obj.get('type') == 'assistant':
        content = obj.get('message', {}).get('content', [])
        if isinstance(content, list):
            for block in content:
                if block.get('type') == 'text':
                    texts.append(block['text'])

texts.reverse()
result = '\\n'.join(texts)

# Truncate to 8000 chars
if len(result) > 8000:
    result = result[:8000] + '\\n[truncated]'

print(json.dumps(result))
`;

function writeStopHook(): void {
  if (!existsSync(RADAR_HOOKS_DIR)) {
    mkdirSync(RADAR_HOOKS_DIR, { recursive: true });
  }
  writeFileSync(STOP_HOOK_PATH, STOP_HOOK_SCRIPT, 'utf8');
  chmodSync(STOP_HOOK_PATH, 0o755);
}

function writeExtractScript(): void {
  if (!existsSync(RADAR_HOOKS_DIR)) {
    mkdirSync(RADAR_HOOKS_DIR, { recursive: true });
  }
  writeFileSync(EXTRACT_SCRIPT_PATH, EXTRACT_SCRIPT_CONTENT, 'utf8');
}

function installStopHooks(settings: Record<string, unknown>): void {
  const hooks = (settings.hooks as Record<string, unknown[]> | undefined) ?? {};

  const hookEntry = {
    hooks: [
      {
        type: 'command',
        command: STOP_HOOK_PATH,
        async: true,
      },
    ],
  };

  // Helper: append hook entry if not already present (idempotent)
  function appendHook(hookName: string): void {
    const existing = (hooks[hookName] as unknown[] | undefined) ?? [];
    const alreadyInstalled = existing.some((h) => {
      if (typeof h !== 'object' || h === null) return false;
      const hooksArr = (h as Record<string, unknown>).hooks;
      if (!Array.isArray(hooksArr)) return false;
      return hooksArr.some(
        (inner) =>
          typeof inner === 'object' &&
          inner !== null &&
          (inner as Record<string, unknown>).command === STOP_HOOK_PATH,
      );
    });
    if (!alreadyInstalled) {
      hooks[hookName] = [...existing, hookEntry];
    }
  }

  appendHook('Stop');
  appendHook('StopFailure');

  settings.hooks = hooks;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runSetup(preEnteredKey?: string): Promise<void> {
  writeln(CYAN + BOLD + sep('── Radar Setup ') + RESET);

  // ── Write OTel config ─────────────────────────────────────────────────────
  let settings: Record<string, unknown>;
  try {
    settings = readSettings();
  } catch (err) {
    writeln(YELLOW + '✗ ' + (err instanceof Error ? err.message : String(err)) + RESET);
    process.exit(1);
  }

  const existingEnv = (settings.env as Record<string, string> | undefined) ?? {};

  writeln(`Writing OTel config to ${SETTINGS_PATH.replace(homedir(), '~')}...`);
  writeln();

  for (const [key, value] of Object.entries(OTEL_VARS)) {
    const alreadySet = key in existingEnv && existingEnv[key] === value;
    const tag = alreadySet ? DIM + '  (already set)' + RESET : '';
    writeln(`  ${GREEN}✓${RESET} ${key}${tag}`);
  }

  settings.env = { ...existingEnv, ...OTEL_VARS };

  // ── Install Stop hooks ────────────────────────────────────────────────────
  writeln();
  writeln('Installing Stop hooks...');

  try {
    writeStopHook();
    writeln(`  ${GREEN}✓${RESET} Hook script written to ${STOP_HOOK_PATH.replace(homedir(), '~')}`);
  } catch (err) {
    writeln(`  ${YELLOW}⚠${RESET} Failed to write hook script: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    writeExtractScript();
    writeln(`  ${GREEN}✓${RESET} Extract script written to ${EXTRACT_SCRIPT_PATH.replace(homedir(), '~')}`);
  } catch (err) {
    writeln(`  ${YELLOW}⚠${RESET} Failed to write extract script: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    installStopHooks(settings);
    writeln(`  ${GREEN}✓${RESET} Stop + StopFailure hooks registered in settings.json`);
  } catch (err) {
    writeln(`  ${YELLOW}⚠${RESET} Failed to register hooks: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    writeSettings(settings);
  } catch (err) {
    writeln();
    writeln(YELLOW + '✗ Failed to write settings: ' + (err instanceof Error ? err.message : String(err)) + RESET);
    process.exit(1);
  }

  writeln();
  writeln(`${GREEN}✓${RESET} Settings written to ${SETTINGS_PATH.replace(homedir(), '~')}`);

  // ── API key ───────────────────────────────────────────────────────────────
  await promptApiKey(preEnteredKey);

  // ── Done ──────────────────────────────────────────────────────────────────
  writeln();
  writeln('Ready. Restart Claude Code for the Stop hooks to take effect, then:');
  writeln(`  ${BOLD}radar watch${RESET}`);
  writeln(DIM + sep() + RESET);
}

// ─── API key prompt ────────────────────────────────────────────────────────────

async function promptApiKey(preEnteredKey?: string): Promise<void> {
  writeln();

  let apiKey: string | undefined = preEnteredKey;

  // ── If no key was passed via --api-key, check for an existing one or prompt ─
  if (!apiKey) {
    const config = readConfig();
    const envKey = process.env.ANTHROPIC_API_KEY;
    const hasStored = config.apiKey ?? config.apiKeyRef;
    const activeKey = envKey ?? config.apiKey;

    if (hasStored || envKey) {
      // Show what's already configured
      if (envKey) {
        const masked = envKey.slice(0, 10) + '…' + envKey.slice(-4);
        writeln(`${GREEN}✓${RESET} API key found via ANTHROPIC_API_KEY env var: ${DIM}${masked}${RESET}`);
      } else if (config.apiKeyRef) {
        writeln(`${GREEN}✓${RESET} API key linked via 1Password: ${DIM}${config.apiKeyRef}${RESET}`);
      } else if (config.apiKey) {
        const masked = config.apiKey.slice(0, 10) + '…' + config.apiKey.slice(-4);
        writeln(`${GREEN}✓${RESET} API key stored locally: ${DIM}${masked}${RESET}`);
      }

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await question(rl, '  Replace it? [y/N] ');
      rl.close();

      if (answer.trim().toLowerCase() !== 'y') return;

      // Fall through to prompt for new key
      void activeKey; // suppress unused warning
    } else {
      writeln(`${YELLOW}⚠${RESET} No API key found. Radar needs one to run analysis.`);
    }

    // Prompt for the key
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const entered = await question(rl, '  Enter your Anthropic API key: ');
    rl.close();

    apiKey = entered.trim();
    if (!apiKey) {
      writeln(`${YELLOW}⚠${RESET} No key entered — skipping. Re-run setup or use --api-key <key>.`);
      return;
    }
  }

  // ── Ask where to store it ─────────────────────────────────────────────────
  await promptStorage(apiKey);
}

// ─── Storage choice ────────────────────────────────────────────────────────────

async function promptStorage(apiKey: string): Promise<void> {
  const opAvailable = isOpAvailable();

  writeln();
  writeln('Where would you like to store the API key?');
  writeln(`  ${BOLD}1${RESET}  Local disk  ${DIM}(${configPath().replace(homedir(), '~')})${RESET}`);

  if (opAvailable) {
    writeln(`  ${BOLD}2${RESET}  1Password   ${DIM}(recommended)${RESET}`);
  } else {
    writeln(`  ${DIM}2  1Password   (op CLI not found — see instructions below)${RESET}`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await question(rl, `  Choice [1${opAvailable ? '/2' : ''}]: `);
  rl.close();

  const choice = answer.trim();

  if (choice === '2') {
    if (!opAvailable) {
      writeln();
      writeln(`${YELLOW}⚠${RESET}  1Password CLI (op) is not installed.`);
      writeln('   To set it up:');
      writeln(`   ${DIM}1. Install: https://developer.1password.com/docs/cli/get-started${RESET}`);
      writeln(`   ${DIM}2. Sign in: op signin${RESET}`);
      writeln(`   ${DIM}3. Re-run:  radar setup --api-key <key>${RESET}`);
      return;
    }

    await storeIn1Password(apiKey);
    return;
  }

  // Default: local disk
  storeLocally(apiKey);
}

function storeLocally(apiKey: string): void {
  const config = readConfig();
  writeConfig({ ...config, apiKey, apiKeyRef: undefined });
  writeln();
  writeln(`${GREEN}✓${RESET} API key saved to ${configPath().replace(homedir(), '~')}`);
}

async function storeIn1Password(apiKey: string): Promise<void> {
  writeln();
  writeln('How would you like to store it in 1Password?');
  writeln(`  ${BOLD}1${RESET}  Create a new item ${DIM}(radar will add it for you)${RESET}`);
  writeln(`  ${BOLD}2${RESET}  Use an existing item ${DIM}(enter an op:// reference)${RESET}`);

  const rl1 = createInterface({ input: process.stdin, output: process.stdout });
  const choice = await question(rl1, '  Choice [1/2]: ');
  rl1.close();

  if (choice.trim() === '2') {
    await useExistingOpRef();
    return;
  }

  // Create a new item
  writeln();
  writeln('Creating item in 1Password...');

  try {
    const ref = createOpItem(apiKey);
    const config = readConfig();
    writeConfig({ ...config, apiKey: undefined, apiKeyRef: ref });
    writeln(`${GREEN}✓${RESET} API key stored in 1Password`);
    writeln(`  Reference: ${DIM}${ref}${RESET}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeln(`${YELLOW}✗${RESET} Failed to store in 1Password: ${msg}`);
    writeln('  Make sure you are signed in: ' + DIM + 'op signin' + RESET);

    // Offer local fallback
    const rl2 = createInterface({ input: process.stdin, output: process.stdout });
    const fallback = await question(rl2, '  Store on local disk instead? [Y/n] ');
    rl2.close();

    if (fallback.trim().toLowerCase() !== 'n') {
      storeLocally(apiKey);
    }
  }
}

async function useExistingOpRef(): Promise<void> {
  writeln();
  writeln(`  Enter the ${BOLD}op://${RESET} reference for your API key.`);
  writeln(`  ${DIM}Example: op://Personal/Anthropic/credential${RESET}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ref = await question(rl, '  Reference: ');
  rl.close();

  const trimmed = ref.trim();
  if (!trimmed.startsWith('op://')) {
    writeln(`${YELLOW}⚠${RESET} Invalid reference — must start with op://. Re-run setup to try again.`);
    return;
  }

  const config = readConfig();
  writeConfig({ ...config, apiKey: undefined, apiKeyRef: trimmed });
  writeln(`${GREEN}✓${RESET} 1Password reference saved: ${DIM}${trimmed}${RESET}`);
}
