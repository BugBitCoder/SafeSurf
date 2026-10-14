#!/usr/bin/env node
/**
 * Unit suite. No dependencies — uses Node's built-in runner.
 *
 *   node --test tests/unit/
 *   npm test
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const files = readdirSync(HERE)
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => join(HERE, f));

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);