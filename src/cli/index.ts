import { Command } from 'commander';
import { startWatch } from './watch.js';
import { runSetup } from './setup.js';
import { resolveStoredApiKey } from './config.js';
import { printError } from '../output/formatter.js';

const program = new Command();

program
  .name('radar')
  .description('Non-blocking intent alignment checker for Claude Code, powered by OpenTelemetry')
  .version('0.1.0');

program
  .command('watch')
  .description('Start listening for Claude Code telemetry and provide intent advisories')
  .option('-p, --port <number>', 'Port to listen on for OTLP log exports', '4820')
  .option(
    '-t, --timeout <ms>',
    'Milliseconds of silence before a turn is considered complete',
    '5000',
  )
  .option(
    '-s, --threshold <score>',
    'Ambiguity score threshold for triggering a pre-advisory (0.0–1.0)',
    '0.6',
  )
  .option('-k, --api-key <key>', 'Anthropic API key (overrides all other sources)')
  .action(async (opts: { port: string; timeout: string; threshold: string; apiKey?: string }) => {
    const port = parseInt(opts.port, 10);
    const boundaryTimeoutMs = parseInt(opts.timeout, 10);
    const scoreThreshold = parseFloat(opts.threshold);

    if (isNaN(port) || port < 1 || port > 65535) {
      printError('--port must be a number between 1 and 65535');
      process.exit(1);
    }

    if (isNaN(boundaryTimeoutMs) || boundaryTimeoutMs < 500) {
      printError('--timeout must be a number >= 500 (ms)');
      process.exit(1);
    }

    if (isNaN(scoreThreshold) || scoreThreshold < 0 || scoreThreshold > 1) {
      printError('--threshold must be a number between 0.0 and 1.0');
      process.exit(1);
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

    await startWatch({ port, boundaryTimeoutMs, scoreThreshold, apiKey });
  });

program
  .command('setup')
  .description('Write OTel config to ~/.claude/settings.json and store your Anthropic API key')
  .option('-k, --api-key <key>', 'Anthropic API key to store (skips the interactive prompt)')
  .action(async (opts: { apiKey?: string }) => {
    await runSetup(opts.apiKey);
  });

// Show help if no command is given
if (process.argv.length === 2) {
  program.outputHelp();
  process.exit(0);
}

program.parse(process.argv);
