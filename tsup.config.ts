import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  target: 'node18',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  bundle: true,
  platform: 'node',
  banner: {
    js: '#!/usr/bin/env node',
  },
  external: ['@anthropic-ai/sdk'],
});
