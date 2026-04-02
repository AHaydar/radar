import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
  writeln('Ready. Start Radar in a second terminal pane:');
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
