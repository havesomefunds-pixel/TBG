import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const docker = process.platform === 'win32' ? 'docker.exe' : 'docker';
const prisma = resolve(root, 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma');
const vitest = resolve(root, 'node_modules', 'vitest', 'vitest.mjs');
const databaseUrl = 'postgresql://tbg_test:tbg_test_only@127.0.0.1:55439/tbg_test';

if (!existsSync(prisma) || !existsSync(vitest)) throw new Error('Install dependencies with npm ci before running integration tests.');
const run = (file, args, env = process.env) => execFileSync(file, args, { cwd: root, env, stdio: 'inherit' });
const composeArgs = ['compose', '-f', 'compose.integration.yml'];

try {
  execFileSync(docker, ['version'], { cwd: root, stdio: 'ignore' });
} catch {
  throw new Error('Docker CLI is required for the disposable PostgreSQL 17 integration fixture.');
}

try {
  run(docker, [...composeArgs, 'down', '--volumes', '--remove-orphans']);
  run(docker, [...composeArgs, 'up', '--detach', '--wait']);
  const env = { ...process.env, DATABASE_URL: databaseUrl, TBG_INTEGRATION: '1' };
  run(prisma, ['migrate', 'deploy'], env);
  run(process.execPath, [vitest, 'run', 'tests/integration'], env);
} finally {
  try { run(docker, [...composeArgs, 'down', '--volumes', '--remove-orphans']); } catch { /* preserve the original test error */ }
}
