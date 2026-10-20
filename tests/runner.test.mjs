/* ==========================================================================
   runner.test.mjs — the safe execution boundary.

   These tests run real child processes (node only) in temporary directories.
   They prove the parts that can be proven without a container: the command
   allowlist, shell-metacharacter rejection, timeouts, output capture, output
   caps, and — most importantly — that server secrets are not visible to the
   code being executed.

   They do NOT prove kernel-level isolation. On a host without Docker or user
   namespaces the runner says so, and this test asserts that it says so.

   Run:  node tests/runner.test.mjs
   ========================================================================== */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateCommand, run, capabilities, ALLOWED_COMMANDS } from '../server/runner.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? `— ${extra}` : ''); }
};
const group = (title) => console.log(`\n— ${title} —`);

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-runner-'));

/* =============================== allowlist =============================== */
group('the command allowlist is enforced before a process exists');

t('an unknown binary is refused', validateCommand('rm', ['-rf', '/']).ok === false);
t('a path is refused', validateCommand('/bin/rm', ['-rf', '/']).ok === false);
t('a shell is refused', validateCommand('sh', ['-c', 'echo hi']).ok === false);
t('a disallowed subcommand is refused', validateCommand('npm', ['publish']).ok === false);
t('an allowed subcommand passes', validateCommand('npm', ['test']).ok === true);
t('shell metacharacters are refused',
  validateCommand('node', ['-e', 'console.log(1); rm -rf /']).ok === false);
t('a bare file argument passes', validateCommand('node', ['index.js']).ok === true);
t('every allowlisted command is documented',
  Object.values(ALLOWED_COMMANDS).every(rule => Boolean(rule.note)));
t('the allowlist does not include a shell',
  !Object.keys(ALLOWED_COMMANDS).some(bin => ['sh', 'bash', 'zsh', 'eval'].includes(bin)));

/* ============================== real runs ================================ */
group('permitted commands actually run and report their exit code');

const goodFile = path.join(workspace, 'good.js');
const badFile = path.join(workspace, 'bad.js');
await fs.writeFile(goodFile, 'export const answer = 42;\n');
await fs.writeFile(badFile, 'function broken( {\n');

{
  const result = await run({ cwd: workspace, command: 'node', args: ['--check', 'good.js'], timeoutMs: 15000 });
  t('a passing syntax check reports ok', result.ok === true, JSON.stringify(result).slice(0, 200));
  t('the exit code is captured', result.exitCode === 0, String(result.exitCode));
  t('the command is echoed back', result.command === 'node --check good.js', result.command);
  t('a duration is measured', typeof result.durationMs === 'number' && result.durationMs >= 0);
  t('isolation details are reported',
    Boolean(result.isolation) && Array.isArray(result.isolation.applied), JSON.stringify(result.isolation));
}

{
  const result = await run({ cwd: workspace, command: 'node', args: ['--check', 'bad.js'], timeoutMs: 15000 });
  t('a failing syntax check reports not ok', result.ok === false, String(result.exitCode));
  t('stderr is captured', /Error|SyntaxError/i.test(result.stderr), result.stderr.slice(0, 120));
}

{
  const result = await run({ cwd: workspace, command: 'rm', args: ['-rf', 'x'] });
  t('a refused command never starts a process', result.refused === true && result.exitCode === null);
  t('the refusal explains why', /allowlist/.test(result.stderr), result.stderr);
}

/* =============================== timeouts ================================ */
group('timeouts cancel the whole process tree');

{
  const slow = path.join(workspace, 'slow.js');
  await fs.writeFile(slow, 'setTimeout(() => {}, 60000);\n');
  const started = Date.now();
  const result = await run({ cwd: workspace, command: 'node', args: [slow], timeoutMs: 1500 });
  const elapsed = Date.now() - started;
  t('a long-running command is cancelled', result.timedOut === true, JSON.stringify(result).slice(0, 160));
  t('it is cancelled promptly', elapsed < 15000, `${elapsed}ms`);
  t('the cancellation is visible in stderr', /exceeded|cancelled/i.test(result.stderr), result.stderr.slice(0, 120));
}

/* =========================== secret hygiene ============================== */
group('the executed code cannot see the server secrets');

{
  process.env.JARVIS_CANARY_SECRET = 'canary-value-must-not-leak';
  process.env.OPENAI_API_KEY = 'sk-canary-key-not-real';

  const probeFile = path.join(workspace, 'env-dump.js');
  await fs.writeFile(probeFile, `
    const leaked = Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET|PASSWORD/i.test(k));
    console.log(JSON.stringify(leaked));
  `);

  const result = await run({ cwd: workspace, command: 'node', args: [probeFile], timeoutMs: 15000 });
  const leaked = (() => { try { return JSON.parse(result.stdout.trim()); } catch { return ['<unparseable>']; } })();

  t('no secret-shaped variable reaches the child', leaked.length === 0, JSON.stringify(leaked));
  t('the canary never appears in the captured output',
    !result.stdout.includes('canary-value-must-not-leak') && !result.stderr.includes('sk-canary-key-not-real'));

  delete process.env.JARVIS_CANARY_SECRET;
  delete process.env.OPENAI_API_KEY;
}

/* ============================== output caps ============================== */
group('output is capped so a runaway command cannot flood the store');

{
  const noisy = path.join(workspace, 'noisy.js');
  await fs.writeFile(noisy, 'for (let i = 0; i < 200000; i += 1) console.log("x".repeat(50));\n');
  const result = await run({
    cwd: workspace, command: 'node', args: [noisy], timeoutMs: 20000, maxOutputBytes: 4096,
  });
  t('stdout is truncated to the cap', result.stdout.length <= 4096, String(result.stdout.length));
  t('truncation is reported', result.truncated === true);
}

/* ============================== capabilities ============================= */
group('the runner reports its own limits honestly');

{
  const caps = await capabilities({ force: true });
  t('the allowlist is published', Array.isArray(caps.allowlist) && caps.allowlist.length > 0);
  t('wrapper availability is reported as facts',
    typeof caps.wrappers.prlimit === 'boolean' && typeof caps.wrappers.docker === 'boolean');
  t('a missing container runtime produces a note, not a claim of isolation',
    caps.wrappers.docker || caps.notes.some(n => /Docker/i.test(n)), JSON.stringify(caps.notes));
  console.log(`    (host: ${caps.platform || 'unknown'} · prlimit=${caps.wrappers.prlimit} · unshare=${caps.wrappers.unshare} · docker=${caps.wrappers.docker})`);
}

/* ================================ cleanup ================================ */
await fs.rm(workspace, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
