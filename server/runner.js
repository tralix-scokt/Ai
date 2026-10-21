/* ==========================================================================
   server/runner.js — the safe execution boundary for project checks.

   WHAT THIS IS
     A controlled runner for *permitted* commands (`npm test`, `go test`,
     `pytest`, …). Every run happens in a throwaway directory, with a clean
     environment, a hard timeout, output caps, and no shell.

   WHAT THIS IS NOT
     A security sandbox against malicious code. A plain child process shares
     the host kernel with the server. Two things make that acceptable, and
     both are enforced here rather than assumed:

       1. Only an allowlisted binary with an allowlisted subcommand can start.
          No shell, no globbing, no redirection, no command substitution.
       2. Optional OS-level wrappers are applied *when they exist*, and the
          response says exactly which ones were applied:
            · `prlimit`  → CPU seconds, address space, file size, process count
            · `unshare -rn` → a private network namespace (no network at all)
            · `docker`   → a real container with `--network none`

     `GET /api/v2/sandbox/status` reports what this host actually supports. If
     Docker and user namespaces are both unavailable, the UI says so plainly —
     JARVIS never claims an isolated sandbox exists when it does not.

   To get a genuine security boundary, set JARVIS_SANDBOX_DRIVER=docker (or run
   the backend inside a container/gVisor/Firecracker microVM).
   ========================================================================== */

import * as Store from './store.js';

/* ------------------------------- allowlist -------------------------------- */

/**
 * The only commands JARVIS may run. Each entry lists the subcommands it may
 * receive; anything else is refused before a process is created.
 */
export const ALLOWED_COMMANDS = {
  node: { subs: ['--version', '--check', '-e', 'test'], note: 'node --check <file>, node <file>, node -e' },
  npm: { subs: ['run', 'test', 'ci', 'ls', '--version'], note: 'npm run <script>, npm test, npm ci, npm ls' },
  pnpm: { subs: ['run', 'test', 'install', '--version'], note: 'pnpm run <script>, pnpm test' },
  yarn: { subs: ['run', 'test', 'install', '--version'], note: 'yarn run <script>, yarn test' },
  npx: { subs: ['--version'], note: 'npx is network-heavy: only --version is permitted by default' },
  python3: { subs: ['-m', '--version', '-c'], note: 'python3 -m pytest|unittest, python3 <file>' },
  pytest: { subs: ['--version'], note: 'pytest' },
  go: { subs: ['test', 'build', 'vet', 'version'], note: 'go test ./…, go build, go vet' },
  cargo: { subs: ['test', 'check', 'build', '--version'], note: 'cargo test|check|build' },
  php: { subs: ['-l', '--version'], note: 'php -l (lint) only' },
  ruby: { subs: ['-c', '--version'], note: 'ruby -c (syntax check) only' },
  make: { subs: ['test', 'build', 'lint', '--version'], note: 'make test|build|lint' },
  git: { subs: ['--version', 'status', 'diff', 'log'], note: 'read-only git' },
};

const SHELL_METACHARACTERS = /[;&|`$><\n\r*?(){}[\]'"]/;

export function validateCommand(command, args = []) {
  const bin = String(command || '').trim();
  if (!bin) return { ok: false, reason: 'No command supplied.' };
  if (/[\\/]/.test(bin)) return { ok: false, reason: 'A command must be a bare executable name, not a path.' };

  const rule = ALLOWED_COMMANDS[bin];
  if (!rule) {
    return {
      ok: false,
      reason: `"${bin}" is not on the command allowlist. Permitted: ${Object.keys(ALLOWED_COMMANDS).join(', ')}.`,
    };
  }

  const list = (args || []).map(a => String(a));
  if (!list.length) return { ok: true, bin, args: [] };

  const first = list[0];
  const known = rule.subs.some(sub => first === sub || (sub.endsWith('.js') && /\.js$/.test(first)));
  const isFileArg = /\.(js|mjs|cjs|py|rb|php|ts)$/i.test(first) || first.startsWith('./');
  if (!known && !isFileArg && !first.startsWith('-')) {
    return { ok: false, reason: `"${bin} ${first}" is not permitted. Allowed: ${rule.note}.` };
  }

  for (const arg of list) {
    if (SHELL_METACHARACTERS.test(arg) && !/^--?[\w-]+$/.test(arg)) {
      return { ok: false, reason: `Refused an argument containing shell syntax: ${arg.slice(0, 40)}` };
    }
  }
  return { ok: true, bin, args: list };
}

/* ------------------------------ host detection ---------------------------- */

let capabilityCache = null;

/**
 * Probe the host for the isolation primitives that actually exist. Result is
 * cached per process; `?force=1` re-checks.
 */
export async function capabilities({ force = false } = {}) {
  if (capabilityCache && !force) return capabilityCache;

  const base = {
    platform: '',
    driver: 'process',
    node: Boolean(globalThis.process?.versions?.node),
    allowlist: Object.keys(ALLOWED_COMMANDS),
    wrappers: { prlimit: false, unshare: false, docker: false },
    notes: [],
  };

  if (!base.node) {
    capabilityCache = {
      ...base,
      available: false,
      notes: ['This runtime cannot spawn processes (serverless isolate). Checks cannot run here.'],
    };
    return capabilityCache;
  }

  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    base.platform = `${os.type?.() || 'unknown'} ${os.release?.() || ''}`.trim();

    const findInPath = (name) => {
      const dirs = String(process.env.PATH || '').split(':').filter(Boolean);
      const extra = ['/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/sbin'];
      for (const dir of [...dirs, ...extra]) {
        const target = `${dir}/${name}`;
        try {
          fs.statSync(target);
          return target;
        } catch { /* keep looking */ }
      }
      return '';
    };

    base.wrappers.prlimit = Boolean(findInPath('prlimit'));
    base.wrappers.unshare = Boolean(findInPath('unshare'));
    base.wrappers.docker = Boolean(findInPath('docker'));
  } catch {
    base.notes.push('Filesystem introspection is unavailable in this runtime.');
  }

  if (!base.wrappers.prlimit) {
    base.notes.push('prlimit not found: CPU, memory and process-count limits cannot be enforced by the kernel. Timeouts still apply.');
  }
  if (!base.wrappers.unshare) {
    base.notes.push('unshare not found: network access cannot be removed at the namespace level. Set JARVIS_SANDBOX_NETWORK=on only for trusted projects.');
  }
  if (!base.wrappers.docker) {
    base.notes.push('Docker not available: the container driver is disabled. Run the backend on a host with Docker (or in a container) for real isolation.');
  }

  base.available = true;
  capabilityCache = base;
  return base;
}

/* --------------------------------- running -------------------------------- */

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE|AUTH)/i;

/**
 * A minimal, scrubbed environment. Provider keys and GitHub tokens are removed
 * so a test that prints `process.env` cannot leak the deployment's secrets.
 */
function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env || {})) {
    if (SECRET_ENV.test(key)) continue;
    env[key] = value;
  }
  const keep = {
    PATH: env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: env.HOME || '/tmp',
    LANG: env.LANG || 'C.UTF-8',
    TMPDIR: env.TMPDIR || '/tmp',
    CI: 'true',
    NODE_ENV: 'test',
    FORCE_COLOR: '0',
    npm_config_yes: 'true',
  };
  const out = { ...keep };
  for (const [key, value] of Object.entries(extra || {})) {
    if (SECRET_ENV.test(key)) continue;
    out[key] = String(value);
  }
  return out;
}

/**
 * Run one command.
 * @param {object} opts
 * @param {string} opts.cwd              directory to run in (must exist)
 * @param {string} opts.command          allowlisted binary
 * @param {string[]} opts.args
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.maxOutputBytes]
 * @param {number} [opts.memoryMb]
 * @param {'off'|'on'} [opts.network]
 * @param {'process'|'docker'} [opts.driver]
 * @param {object} [opts.env]
 */
export async function run({
  cwd,
  command,
  args = [],
  timeoutMs = 180_000,
  maxOutputBytes = 262_144,
  memoryMb = 512,
  network = 'off',
  driver = 'process',
  env: extraEnv = {},
  image = '',
} = {}) {
  const started = Date.now();
  const check = validateCommand(command, args);
  if (!check.ok) {
    return { ok: false, refused: true, exitCode: null, stdout: '', stderr: check.reason, durationMs: 0 };
  }

  let cp;
  let fs;
  let os;
  try {
    cp = await import('node:child_process');
    fs = await import('node:fs');
    os = await import('node:os');
  } catch {
    return {
      ok: false, refused: true, exitCode: null, stdout: '', stderr:
        'This runtime cannot spawn processes. Run the Node backend to execute project checks.',
      durationMs: Date.now() - started,
    };
  }

  const applied = [];
  const warnings = [];

  let workDir = cwd;
  // A directory we create ourselves is ours to remove again — an empty temp
  // directory per call would otherwise pile up for as long as the server runs.
  let ownDir = null;
  if (!workDir || !fs.existsSync(workDir)) {
    workDir = fs.mkdtempSync(`${os.tmpdir()}/jarvis-run-`);
    ownDir = workDir;
    warnings.push('No working directory was supplied; an empty temporary directory was used and removed afterwards.');
  }

  const removeOwnDir = () => {
    if (!ownDir) return;
    try { fs.rmSync(ownDir, { recursive: true, force: true }); } catch { /* best effort */ }
    ownDir = null;
  };

  let spawnBin = check.bin;
  let spawnArgs = check.args;

  if (driver === 'docker') {
    const caps = await capabilities();
    if (!caps.wrappers.docker) {
      warnings.push('Docker was requested but is not installed — fell back to the process driver.');
    } else {
      spawnBin = 'docker';
      spawnArgs = [
        'run', '--rm',
        '--network', network === 'off' ? 'none' : 'bridge',
        '--memory', `${memoryMb}m`,
        '--cpus', '1',
        '--pids-limit', '128',
        '-v', `${workDir}:/work`,
        '-w', '/work',
        image || 'node:20-slim',
        check.bin, ...check.args,
      ];
      applied.push('docker container', `--network ${network === 'off' ? 'none' : 'bridge'}`, `--memory ${memoryMb}m`, '--pids-limit 128');
    }
  }

  if (spawnBin === check.bin && driver !== 'docker') {
    const caps = await capabilities();
    if (network === 'off' && caps.wrappers.unshare) {
      spawnBin = 'unshare';
      spawnArgs = ['-rn', check.bin, ...check.args];
      applied.push('unshare -rn (private network namespace)');
    } else if (network === 'off') {
      warnings.push('Network isolation was requested but user namespaces are unavailable. The command can reach the network.');
    }

    if (caps.wrappers.prlimit && spawnBin !== 'docker') {
      const cpuSeconds = Math.max(5, Math.ceil(timeoutMs / 1000));
      const fsizeBytes = 64 * 1024 * 1024;
      // RLIMIT_AS caps *virtual* address space, not resident memory. Language
      // runtimes reserve large virtual ranges up front (Node reserves ~1 GB for
      // its code range alone), so a small value kills every process instantly.
      // Use a generous multiple of the requested memory, and never below the
      // floor a modern runtime needs.
      const asMb = Math.max(4096, Math.round(memoryMb) * 4);
      spawnArgs = [
        `--as=${asMb * 1024 * 1024}`,
        `--cpu=${cpuSeconds}`,
        `--fsize=${fsizeBytes}`,
        '--nproc=128',
        spawnBin, ...spawnArgs,
      ];
      spawnBin = 'prlimit';
      applied.push(`prlimit (virtual address space ${asMb}MB, cpu ${cpuSeconds}s, file size 64MB, 128 processes)`);
    }
  }

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let killed = false;

    const child = cp.spawn(spawnBin, spawnArgs, {
      cwd: workDir,
      env: cleanEnv(extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,                       // own process group → we can kill the tree
      shell: false,
    });

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeOwnDir();
      resolve({
        ok: payload.exitCode === 0 && !payload.timedOut,
        timedOut: Boolean(payload.timedOut),
        exitCode: payload.exitCode,
        signal: payload.signal || '',
        command: `${check.bin} ${check.args.join(' ')}`.trim(),
        stdout: stdout.slice(0, maxOutputBytes),
        stderr: (stderr + (payload.timedOut ? `\n[jarvis] command exceeded ${timeoutMs}ms and was cancelled.` : '')).slice(0, maxOutputBytes),
        truncated,
        durationMs: Date.now() - started,
        isolation: { driver: driver === 'docker' ? 'docker' : 'process', network, applied, warnings },
      });
    };

    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      finish({ exitCode: null, timedOut: true, signal: 'SIGKILL' });
    }, Math.max(1000, timeoutMs));

    const cap = (chunk, current) => {
      if (current.length + chunk.length > maxOutputBytes) { truncated = true; return current; }
      return current + chunk;
    };

    child.stdout?.on('data', (chunk) => { stdout = cap(String(chunk), stdout); });
    child.stderr?.on('data', (chunk) => { stderr = cap(String(chunk), stderr); });
    child.on('error', (err) => {
      stderr += `\n[jarvis] could not start: ${String(err?.message || err)}`;
      finish({ exitCode: null });
    });
    child.on('close', (code, signal) => {
      if (killed) return;
      finish({ exitCode: code, signal: String(signal || '') });
    });
  });
}

/* --------------------------- project check detection ---------------------- */

/**
 * Work out which checks make sense for a repository. Detected from files the
 * task already fetched — no guessing, and nothing runs unless the user asks.
 */
export function detectChecks(files = []) {
  const paths = (files || []).map(f => f.path || f);
  const has = (name) => paths.some(p => p === name || p.endsWith(`/${name}`));
  const checks = [];

  if (has('package.json')) {
    // `npm test` almost always needs dependencies: it is offered, but only run
    // when the deployment allows network access in the sandbox.
    checks.push({ id: 'npm-test', label: 'npm test', command: 'npm', args: ['test'], reason: 'package.json present' });
  }
  if (has('requirements.txt') || has('pyproject.toml')) {
    checks.push({ id: 'pytest', label: 'pytest', command: 'python3', args: ['-m', 'pytest'], reason: 'Python project files present' });
  }
  if (has('go.mod')) {
    checks.push({ id: 'go-test', label: 'go test ./...', command: 'go', args: ['test', './...'], reason: 'go.mod present' });
  }
  if (has('Cargo.toml')) {
    checks.push({ id: 'cargo-test', label: 'cargo test', command: 'cargo', args: ['test'], reason: 'Cargo.toml present' });
  }
  return checks;
}

/** Run a list of checks sequentially, stopping at the first failure. */
export async function runChecks(checks, options = {}) {
  const results = [];
  for (const check of checks) {
    const result = await run({ ...options, command: check.command, args: check.args || [] });
    results.push({ id: check.id, label: check.label, reason: check.reason, ...result });
    if (!result.ok) break;
  }
  return results;
}

export async function sandboxStatus() {
  const settings = await Store.getSettings();
  const caps = await capabilities({ force: true });
  return {
    ...caps,
    configured: {
      driver: settings.sandbox?.driver || 'process',
      network: settings.sandbox?.network || 'off',
      timeoutMs: settings.sandbox?.timeoutMs || 180_000,
      memoryMb: settings.sandbox?.memoryMb || 512,
    },
    recommendation: caps.wrappers.docker
      ? 'Docker is available: set JARVIS_SANDBOX_DRIVER=docker for a real isolation boundary.'
      : 'No container runtime detected. Set JARVIS_SANDBOX_DRIVER=docker on a host with Docker to get true isolation; until then only the allowlist, timeouts and (if present) prlimit/unshare apply.',
  };
}
