import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Paths ─────────────────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), '.config', 'radar');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface RadarConfig {
  apiKey?: string;      // plaintext local storage
  apiKeyRef?: string;   // 1Password reference e.g. op://vault/item/field
}

// ─── Read / write ──────────────────────────────────────────────────────────────

export function readConfig(): RadarConfig {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as RadarConfig;
  } catch {
    return {};
  }
}

export function writeConfig(config: RadarConfig): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
  // mode 0o600 → readable/writable by owner only; protects the plaintext API key
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function configPath(): string {
  return CONFIG_PATH;
}

// ─── 1Password helpers ─────────────────────────────────────────────────────────

export function isOpAvailable(): boolean {
  try {
    execSync('op --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Run `op item create` and return the `op://` reference for the stored key. */
export function createOpItem(apiKey: string): string {
  const title = 'Radar Anthropic API Key';
  // Use execFileSync (no shell) to avoid shell-injection risks when the key
  // contains quotes, dollar signs, or other shell metacharacters.
  const raw = execFileSync(
    'op',
    ['item', 'create', '--category=login', `--title=${title}`, `password=${apiKey}`, '--format', 'json'],
    { encoding: 'utf8' },
  );
  const item = JSON.parse(raw) as { title: string; vault: { name: string } };
  return `op://${item.vault.name}/${item.title}/password`;
}

/** Read a secret from 1Password by its `op://` reference. */
export function readOpItem(ref: string): string {
  // Use execFileSync (no shell) to avoid injection if the reference contains
  // shell metacharacters (e.g. spaces or backticks from user-supplied input).
  return execFileSync('op', ['read', ref], { encoding: 'utf8' }).trim();
}

// ─── Key resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the API key from the stored config.
 * Tries plaintext `apiKey` first, then fetches via `op read` if `apiKeyRef` is set.
 * Returns undefined if no key is configured.
 * Throws if a 1Password reference is configured but the op read fails.
 */
export function resolveStoredApiKey(): string | undefined {
  const config = readConfig();
  if (config.apiKey) return config.apiKey;
  if (config.apiKeyRef) {
    try {
      return readOpItem(config.apiKeyRef);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to read API key from 1Password (${config.apiKeyRef}).\n` +
        `Make sure you are signed in: op signin\n` +
        `Detail: ${detail}`,
      );
    }
  }
  return undefined;
}
