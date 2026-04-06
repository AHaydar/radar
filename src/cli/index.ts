import { Command } from 'commander';
import { startWatch } from './watch.js';
import { runSetup } from './setup.js';
import { startSniff } from './sniff.js';
import { resolveStoredApiKey, readConfig, writeConfig } from './config.js';
import { printError } from '../output/formatter.js';

const program = new Command();

program
  .name('radar')
  .description('Non-blocking intent alignment checker for Claude Code, powered by OpenTelemetry')
  .version('0.1.5');

program
  .command('watch')
  .description('Start listening for Claude Code telemetry and provide intent advisories')
  .option('-p, --port <number>', 'Port to listen on for OTLP log exports', '4820')
  .option(
    '-s, --threshold <score>',
    'Ambiguity score threshold for triggering a pre-advisory (0.0–1.0)',
    '0.6',
  )
  .option('-k, --api-key <key>', 'Anthropic API key (overrides all other sources)')
  .option('-v, --verbose', 'Show all events including clear/aligned (default: alert-only)')
  .option('-d, --debug', 'Print internal pipeline trace: classifier input/output, post gathering, advisor input, display timing')
  .option('--post-threshold <score>', 'Ambiguity score threshold for triggering a post-advisory (0.0–1.0, defaults to --threshold)')
  .action(async (opts: { port: string; threshold: string; apiKey?: string; verbose?: boolean; debug?: boolean; postThreshold?: string }) => {
    const port = parseInt(opts.port, 10);
    const scoreThreshold = parseFloat(opts.threshold);

    if (isNaN(port) || port < 1 || port > 65535) {
      printError('--port must be a number between 1 and 65535');
      process.exit(1);
    }

    if (isNaN(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 1) {
      printError('--threshold must be a number between 0.0 and 1.0');
      process.exit(1);
    }

    if (opts.postThreshold !== undefined) {
      const pt = parseFloat(opts.postThreshold);
      if (isNaN(pt) || pt < 0 || pt > 1) {
        printError('--post-threshold must be a number between 0.0 and 1.0');
        process.exit(1);
      }
    }

    // Resolution order: --api-key flag → ANTHROPIC_API_KEY env → stored config (local or 1Password)
    let apiKey: string | undefined;
    try {
      apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? resolveStoredApiKey();
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    if (!apiKey) {
      printError('Anthropic API key not found. Run `radar setup`, set ANTHROPIC_API_KEY, or use --api-key <key>.');
      process.exit(1);
    }

    const config = readConfig();
    await startWatch({
      port,
      scoreThreshold,
      postThreshold: isNaN(parseFloat(opts.postThreshold ?? '')) ? scoreThreshold : parseFloat(opts.postThreshold!),
      apiKey,
      verbose: opts.verbose ?? false,
      debug: opts.debug ?? false,
      preAdvisorModel: config.preAdvisorModel,
      postAdvisorModel: config.postAdvisorModel,
    });
  });

program
  .command('setup')
  .description('Write OTel config to ~/.claude/settings.json and store your Anthropic API key')
  .option('-k, --api-key <key>', 'Anthropic API key to store (skips the interactive prompt)')
  .action(async (opts: { apiKey?: string }) => {
    await runSetup(opts.apiKey);
  });

program
  .command('sniff')
  .description('Transparent proxy that logs raw OTel events then forwards to Radar')
  .option('-p, --port <number>', 'Port to listen on (Claude Code sends here)', '4821')
  .option('-f, --forward <number>', 'Port to forward to (where Radar is listening)', '4820')
  .option('--json', 'Output full JSON per event instead of compact one-liners')
  .action(async (opts: { port: string; forward: string; json?: boolean }) => {
    const port = parseInt(opts.port, 10);
    const forwardPort = parseInt(opts.forward, 10);

    if (isNaN(port) || port < 1 || port > 65535) {
      printError('--port must be a number between 1 and 65535');
      process.exit(1);
    }

    if (isNaN(forwardPort) || forwardPort < 1 || forwardPort > 65535) {
      printError('--forward must be a number between 1 and 65535');
      process.exit(1);
    }

    await startSniff({ port, forwardPort, jsonMode: opts.json ?? false });
  });

const configCmd = program
  .command('config')
  .description('Get or set Radar configuration values');

const ALLOWED_CONFIG_KEYS = ['preAdvisorModel', 'postAdvisorModel'] as const;
type ConfigKey = typeof ALLOWED_CONFIG_KEYS[number];
const ALLOWED_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-5'] as const;

configCmd
  .command('set <key> <value>')
  .description('Set a config value (keys: preAdvisorModel, postAdvisorModel)')
  .action((key: string, value: string) => {
    if (!(ALLOWED_CONFIG_KEYS as readonly string[]).includes(key)) {
      printError(`Unknown config key: ${key}. Allowed: ${ALLOWED_CONFIG_KEYS.join(', ')}`);
      process.exit(1);
    }
    if (!(ALLOWED_MODELS as readonly string[]).includes(value)) {
      printError(`Invalid model: ${value}. Allowed: ${ALLOWED_MODELS.join(', ')}`);
      process.exit(1);
    }
    const config = readConfig();
    (config as Record<string, unknown>)[key] = value;
    writeConfig(config);
    process.stdout.write(`Set ${key} = ${value}\n`);
  });

configCmd
  .command('get <key>')
  .description('Get a config value')
  .action((key: string) => {
    const config = readConfig();
    const value = (config as Record<string, unknown>)[key];
    if (value === undefined) {
      process.stdout.write(`${key} is not set (default will be used)\n`);
    } else {
      process.stdout.write(`${key} = ${String(value)}\n`);
    }
  });

configCmd
  .command('list')
  .description('Show all config values')
  .action(() => {
    const config = readConfig();
    const entries = Object.entries(config);
    if (entries.length === 0) {
      process.stdout.write('No config values set.\n');
    } else {
      for (const [k, v] of entries) {
        process.stdout.write(`${k} = ${String(v)}\n`);
      }
    }
  });

// Show help if no command is given
if (process.argv.length === 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse(process.argv);
