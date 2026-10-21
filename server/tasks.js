/* ==========================================================================
   server/tasks.js — the coding-task orchestrator.

   A task moves through explicit states and every transition is persisted, so
   the UI can show real progress and the server can be restarted mid-task:

     queued → analyzing → planning → [awaiting_plan_review]
            → editing → testing → repairing → awaiting_review
            → completed | failed | cancelled

   Nothing here pretends:
     • files are read through the GitHub API, so "analyzed" means the bytes
       actually came back;
     • a plan comes from a model call — if no model is eligible the task fails
       with `no_eligible_model`;
     • tests are executed by server/runner.js and the captured exit code,
       stdout and stderr are stored verbatim;
     • a commit or pull request only happens when the user asks for it.
   ========================================================================== */

import * as Store from './store.js';
import * as Router from './router.js';
import * as GitHub from './github.js';
import * as Runner from './runner.js';
import { diffLines, toUnifiedDiff } from './diff.js';
import { CODES } from './lib/http.js';

export const STATES = [
  'queued', 'analyzing', 'planning', 'awaiting_plan_review',
  'editing', 'testing', 'repairing', 'awaiting_review',
  'completed', 'failed', 'cancelled',
];

export const STATE_LABELS = {
  queued: 'Queued',
  analyzing: 'Analyzing the repository',
  planning: 'Planning the change',
  awaiting_plan_review: 'Waiting for you to approve the plan',
  editing: 'Editing files',
  testing: 'Running checks',
  repairing: 'Repairing failed checks',
  awaiting_review: 'Waiting for your review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const IMPORTANT_FILES = [
  'package.json', 'README.md', 'readme.md', 'pyproject.toml', 'requirements.txt',
  'go.mod', 'Cargo.toml', 'index.html', 'src/index.js', 'src/main.js', 'src/App.jsx',
  'tsconfig.json', 'Makefile', 'composer.json',
];

/* -------------------------------- lifecycle ------------------------------- */

const uid = () => `task_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

function event(task, state, message = '', extra = {}) {
  task.state = state;
  task.updatedAt = Date.now();
  task.events = task.events || [];
  task.events.push({ ts: Date.now(), state, message, ...extra });
  return task;
}

export async function createTask(env, { repo, branch = '', prompt = '', autonomy = '', session = null } = {}) {
  const settings = await Store.getSettings();
  const repository = String(repo || settings.github?.selectedRepo || '').trim();
  if (!repository) {
    throw Object.assign(new Error('Choose a repository first.'), { code: CODES.bad_request });
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw Object.assign(new Error('A repository must look like "owner/name".'), { code: CODES.bad_request });
  }
  const promptText = String(prompt || '').trim();
  if (promptText.length < 8) {
    throw Object.assign(new Error('Describe the task in a sentence or two.'), { code: CODES.bad_request });
  }

  const baseBranch = String(branch || settings.github?.selectedBranch || settings.github?.defaultBranch || '').trim();

  const task = {
    id: uid(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    repo: repository,
    baseBranch,
    branch: '',
    prompt: promptText.slice(0, 8000),
    autonomy: autonomy || settings.tasks?.autonomy || 'review-changes',
    state: 'queued',
    events: [],
    context: { fileCount: 0, files: [], budgetBytes: 0 },
    plan: null,
    changes: [],
    tests: { ran: false, checks: [] },
    repairAttempts: 0,
    review: null,
    result: null,
    error: null,
  };
  event(task, 'queued', 'Task created.');
  await Store.saveTask(task);
  return task;
}

export async function get(id) { return Store.getTask(id); }
export async function list() { return Store.listTasks(); }

/* --------------------------------- analysis ------------------------------- */

/** Score a file path against the words used in the task description. */
function relevance(path, keywords) {
  const lower = String(path).toLowerCase();
  let score = 0;
  for (const word of keywords) if (lower.includes(word)) score += 3;
  if (IMPORTANT_FILES.includes(path)) score += 8;
  if (/^(src|app|lib|packages)\//.test(lower)) score += 2;
  if (/\.(md|txt|lock)$/.test(lower)) score -= 2;
  if (/(test|spec)\./.test(lower)) score -= 1;
  return score;
}

async function analyze(env, task, { session }) {
  event(task, 'analyzing', 'Reading the repository tree from GitHub.');
  await Store.saveTask(task);

  const branch = task.baseBranch || (await defaultBranch(env, task.repo, session));
  task.baseBranch = branch;

  const tree = await GitHub.listTree(env, task.repo, branch, { session });
  task.context.fileCount = tree.length;

  const keywords = [...new Set(
    String(task.prompt).toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [],
  )].slice(0, 40);

  const ranked = tree
    .filter(item => item.size <= 200_000)
    .map(item => ({ ...item, score: relevance(item.path, keywords) }))
    .sort((a, b) => b.score - a.score || a.size - b.size);

  const settings = await Store.getSettings();
  const maxFiles = Math.max(1, Number(settings.tasks?.maxFilesPerTask || 12));
  const maxBytes = Math.max(20_000, Number(settings.tasks?.maxFileBytes || 120_000));

  const chosen = [];
  let bytes = 0;
  for (const item of ranked) {
    if (chosen.length >= maxFiles || bytes >= maxBytes) break;
    if (item.score <= 0 && chosen.length >= 4) break;
    chosen.push(item);
    bytes += item.size;
  }

  const files = [];
  for (const item of chosen) {
    const file = await GitHub.getFile(env, task.repo, branch, item.path, { session, maxBytes: 60_000 });
    files.push({
      path: item.path,
      size: file.size || item.size,
      content: file.content || '',
      truncated: Boolean(file.truncated),
      score: item.score,
    });
  }

  task.context.files = files;
  task.context.budgetBytes = bytes;
  task.context.treeSample = tree.slice(0, 120).map(t => t.path);
  event(task, 'analyzing', `Read ${files.length} of ${tree.length} files from ${task.repo}@${branch}.`);
  await Store.saveTask(task);
  return task;
}

async function defaultBranch(env, repo, session) {
  const branches = await GitHub.listBranches(env, repo, { session }).catch(() => []);
  const found = branches.find(b => /^(main|master|develop|trunk)$/i.test(b.name));
  if (found) return found.name;
  const settings = await Store.getSettings();
  return branches[0]?.name || settings.github?.defaultBranch || 'main';
}

/* --------------------------------- planning ------------------------------- */

const PLAN_INSTRUCTIONS = `You are the planning stage of JARVIS STUDIO, an AI coding assistant.

You will be given a repository snapshot and a task. Reply with JSON only — no prose, no markdown fences.

{
  "summary": "one or two sentences describing the change",
  "files": [
    { "path": "src/example.js", "action": "modify|create|delete", "reason": "why this file" }
  ],
  "checks": ["node --check", "npm test"],
  "risks": ["one concrete risk of this change"]
}

Rules:
- Only include files you actually need. Prefer the smallest change that solves the task.
- Never invent a path that is not in the snapshot unless creating a new file, and then say so in "action".
- If the task cannot be done with the files available, say so in "risks" and return the files you would need.`;

function parseJsonBlock(text) {
  const raw = String(text || '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    // tolerate trailing commas — models emit them surprisingly often
    try {
      return JSON.parse(body.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

function contextPack(task) {
  const files = (task.context.files || []).filter(f => f.content);
  return files
    .map(f => `--- ${f.path}${f.truncated ? ' (truncated)' : ''} ---\n${f.content}`)
    .join('\n\n')
    .slice(0, 60_000);
}

async function plan(env, task, { session }) {
  event(task, 'planning', 'Asking a model for an implementation plan.');
  await Store.saveTask(task);

  const pack = contextPack(task);
  const result = await Router.completeBuffered(env, {
    task: 'plan',
    tier: 'smart',
    require: ['chat'],
    maxTokens: 2048,
    instructions: PLAN_INSTRUCTIONS,
    messages: [{
      role: 'user',
      content: `Repository: ${task.repo} (branch ${task.baseBranch})\n\nTask: ${task.prompt}\n\nFiles in the snapshot:\n${(task.context.files || []).map(f => `- ${f.path}`).join('\n')}\n\nSnapshot:\n${pack}`,
    }],
  });

  const parsed = parseJsonBlock(result.text);
  if (!parsed || !Array.isArray(parsed.files)) {
    event(task, 'failed', 'The model returned a plan JARVIS could not read.', { raw: result.text.slice(0, 2000) });
    task.error = { code: CODES.bad_request, message: 'The model returned a plan JARVIS could not parse. Try rephrasing the task, or run it again.' };
    await Store.saveTask(task);
    return task;
  }

  const settings = await Store.getSettings();
  const maxFiles = Math.max(1, Number(settings.tasks?.maxFilesPerTask || 12));
  task.plan = {
    summary: String(parsed.summary || '').slice(0, 1000),
    files: parsed.files
      .filter(f => f && typeof f.path === 'string')
      .slice(0, maxFiles)
      .map(f => ({
        path: String(f.path).replace(/^\/+/, ''),
        action: ['modify', 'create', 'delete'].includes(String(f.action)) ? String(f.action) : 'modify',
        reason: String(f.reason || '').slice(0, 400),
      })),
    checks: Array.isArray(parsed.checks) ? parsed.checks.map(String).slice(0, 8) : [],
    risks: Array.isArray(parsed.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    model: result.model,
    provider: result.provider,
    providerLabel: result.providerLabel,
    attempts: result.attempts || [],
  };

  event(task, 'planning', `Plan ready from ${task.plan.providerLabel} (${task.plan.model}).`, {
    files: task.plan.files.length,
  });
  await Store.saveTask(task);
  return task;
}

/* ---------------------------------- editing ------------------------------- */

const EDIT_INSTRUCTIONS = `You are the editing stage of JARVIS STUDIO. You apply ONE planned change to ONE file.

Reply with JSON only:
{
  "content": "the complete new contents of the file",
  "notes": "one short sentence on what changed"
}

Rules:
- Return the COMPLETE file, not a fragment and not a diff.
- Keep the project's existing style: indentation, quotes, semicolons, naming.
- Do not add comments that restate the code, and do not add new dependencies unless the task requires it.
- If the file cannot be changed safely, reply with {"content": null, "notes": "why"}.`;

async function ensureBranch(env, task, { session }) {
  if (task.branch) return task.branch;
  const settings = await Store.getSettings();
  const prefix = settings.github?.branchPrefix || 'jarvis/';
  const slug = String(task.prompt).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';
  const name = `${prefix}${slug}-${task.id.slice(-5)}`;
  const created = await GitHub.createBranch(env, task.repo, { from: task.baseBranch, name }, { session });
  task.branch = created.branch;
  task.branchCreated = created.created;
  return task.branch;
}

async function edit(env, task, { session }) {
  event(task, 'editing', `Applying changes to ${task.plan.files.length} file(s).`);
  await Store.saveTask(task);

  const settings = await Store.getSettings();
  const changes = [];
  const known = new Map((task.context.files || []).map(f => [f.path, f.content || '']));

  for (const planned of task.plan.files) {
    let before = known.get(planned.path);
    if (before === undefined) {
      const file = await GitHub.getFile(env, task.repo, task.baseBranch, planned.path, { session, maxBytes: 60_000 });
      before = file.truncated ? '' : (file.content || '');
      if (planned.action === 'modify' && !before) planned.action = 'create';
    }

    if (planned.action === 'delete') {
      const diff = diffLines(before, '');
      changes.push({
        path: planned.path, mode: 'delete', before, after: '',
        reason: planned.reason, notes: 'File deleted.',
        diff: diff.hunks, additions: 0, deletions: diff.deletions,
        unified: toUnifiedDiff(planned.path, before, ''),
      });
      continue;
    }

    const result = await Router.completeBuffered(env, {
      task: 'edit',
      tier: 'code',
      require: ['chat', 'code'],
      maxTokens: 8192,
      instructions: EDIT_INSTRUCTIONS,
      messages: [{
        role: 'user',
        content: `Repository: ${task.repo}\nTask: ${task.prompt}\n\nPlanned change for this file: ${planned.reason}\n\nFile: ${planned.path}\nCurrent contents:\n"""\n${before}\n"""`,
      }],
    });

    const parsed = parseJsonBlock(result.text);
    const after = parsed && typeof parsed.content === 'string' ? parsed.content : '';
    if (!after) {
      event(task, 'editing', `Skipped ${planned.path}: the model returned no usable content.`, { path: planned.path });
      continue;
    }
    if (after === before) {
      event(task, 'editing', `No change needed in ${planned.path}.`, { path: planned.path });
      continue;
    }

    const diff = diffLines(before, after);
    changes.push({
      path: planned.path,
      mode: planned.action === 'create' ? 'create' : 'modify',
      before, after,
      reason: planned.reason,
      notes: String(parsed.notes || '').slice(0, 500),
      diff: diff.hunks,
      additions: diff.additions,
      deletions: diff.deletions,
      unified: toUnifiedDiff(planned.path, before, after),
      model: result.model,
      provider: result.provider,
      providerLabel: result.providerLabel,
    });

    event(task, 'editing', `Updated ${planned.path} (+${diff.additions} −${diff.deletions}).`, { path: planned.path });
    await Store.saveTask(task);
  }

  task.changes = changes;
  if (!changes.length) {
    event(task, 'failed', 'The model produced no file changes for this task.');
    task.error = { code: CODES.bad_request, message: 'JARVIS could not produce any file changes for this task. Try describing the change more concretely.' };
  }
  await Store.saveTask(task);
  return task;
}

/* ---------------------------------- testing ------------------------------- */

/**
 * Materialise a snapshot of the repository into a temporary directory, apply
 * the pending changes, and run the checks the runner allows.
 *
 * This is deliberately not a git clone: no network, no credentials on disk,
 * and the directory is deleted afterwards.
 */
async function materialize(task) {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-snap-'));

  for (const file of task.context.files || []) {
    if (!file.content) continue;
    const target = path.join(dir, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content);
  }
  for (const change of task.changes || []) {
    const target = path.join(dir, change.path);
    if (change.mode === 'delete') {
      await fs.rm(target, { force: true }).catch(() => {});
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, change.after);
  }
  return dir;
}

async function cleanup(dir) {
  if (!dir) return;
  try {
    const fs = await import('node:fs/promises');
    await fs.rm(dir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

async function test(env, task) {
  const settings = await Store.getSettings();
  if (settings.tasks?.runChecks === false) {
    task.tests = { ran: false, skipped: true, checks: [], note: 'Checks are disabled in Settings → Tasks.' };
    event(task, 'testing', 'Checks skipped (disabled in settings).');
    await Store.saveTask(task);
    return task;
  }

  event(task, 'testing', 'Running permitted checks in the isolated runner.');
  await Store.saveTask(task);

  const caps = await Runner.capabilities();
  if (!caps.available) {
    task.tests = {
      ran: false, skipped: true, checks: [],
      note: 'This runtime cannot execute commands. Run the Node backend to enable checks.',
    };
    event(task, 'testing', 'Checks unavailable in this runtime.');
    await Store.saveTask(task);
    return task;
  }

  let dir = '';
  try {
    dir = await materialize(task);
    const checks = [];

    // Dependency-free syntax checks always run and always work offline.
    for (const change of task.changes || []) {
      if (!/\.(m?js|cjs|jsx|ts|tsx)$/i.test(change.path)) continue;
      if (change.mode === 'delete') continue;
      checks.push({
        id: `syntax:${change.path}`,
        label: `Syntax check ${change.path}`,
        command: 'node',
        args: ['--check', change.path],
        reason: 'changed in this task',
      });
    }

    // Project-level test scripts are offered, but they usually need to
    // install dependencies — which needs network and an explicit opt-in.
    const detected = Runner.detectChecks([
      ...(task.context.files || []).map(f => f.path),
      ...(task.changes || []).map(c => c.path),
    ]);
    for (const check of detected) {
      if (!check.command || check.command === 'node') continue;
      checks.push({ ...check, needsNetwork: true });
    }

    const runnable = checks.filter(c => !c.needsNetwork || settings.sandbox?.network === 'on');
    const skipped = checks.filter(c => c.needsNetwork && settings.sandbox?.network !== 'on');

    const results = await Runner.runChecks(runnable, {
      cwd: dir,
      timeoutMs: Number(settings.sandbox?.timeoutMs || 180_000),
      memoryMb: Number(settings.sandbox?.memoryMb || 512),
      network: settings.sandbox?.network || 'off',
      driver: settings.sandbox?.driver || 'process',
      maxOutputBytes: Number(settings.sandbox?.maxOutputBytes || 262_144),
    });

    task.tests = {
      ran: true,
      cwd: dir,
      checks: results,
      skipped: skipped.map(c => ({ id: c.id, label: c.label, reason: 'needs network to install dependencies — enable it in Settings → Execution' })),
      isolation: results[0]?.isolation || null,
    };
    const failed = results.filter(r => !r.ok);
    event(task, 'testing', failed.length
      ? `${failed.length} of ${results.length} checks failed.`
      : `${results.length} check(s) passed.`, { failed: failed.length });
  } catch (err) {
    task.tests = { ran: false, checks: [], error: String(err?.message || err) };
    event(task, 'testing', 'Checks could not be executed.', { error: String(err?.message || err) });
  } finally {
    await cleanup(dir);
  }

  await Store.saveTask(task);
  return task;
}

/* --------------------------------- repairing ------------------------------ */

const REPAIR_INSTRUCTIONS = `You are the repair stage of JARVIS STUDIO. A change was applied and a check failed.

Reply with JSON only:
{
  "content": "the complete corrected contents of the file",
  "notes": "what you fixed"
}

Fix the reported failure. Do not change unrelated behaviour. If the failure is
caused by a missing dependency or a broken environment rather than the code,
reply with {"content": null, "notes": "environment problem: ..."}.`;

async function repair(env, task, { session }) {
  const settings = await Store.getSettings();
  const maxAttempts = Math.max(0, Number(settings.tasks?.maxRepairAttempts ?? 2));
  if (task.repairAttempts >= maxAttempts) return task;

  task.repairAttempts += 1;
  event(task, 'repairing', `Repair attempt ${task.repairAttempts} of ${maxAttempts}.`);
  await Store.saveTask(task);

  const failures = (task.tests?.checks || []).filter(c => !c.ok);
  const failureText = failures.map(f => `### ${f.label}\nexit code: ${f.exitCode}\n${f.stderr}\n${f.stdout}`)
    .join('\n\n')
    .slice(0, 12_000);

  let repaired = 0;
  for (const change of task.changes) {
    if (change.mode === 'delete') continue;
    const result = await Router.completeBuffered(env, {
      task: 'repair',
      tier: 'code',
      require: ['chat', 'code'],
      maxTokens: 8192,
      instructions: REPAIR_INSTRUCTIONS,
      messages: [{
        role: 'user',
        content: `Task: ${task.prompt}\n\nFile: ${change.path}\nCurrent contents:\n"""\n${change.after}\n"""\n\nFailing checks:\n${failureText}`,
      }],
    });
    const parsed = parseJsonBlock(result.text);
    const next = parsed && typeof parsed.content === 'string' ? parsed.content : '';
    if (!next || next === change.after) continue;

    const previous = change.after;
    change.after = next;
    const diff = diffLines(change.before, next);
    change.diff = diff.hunks;
    change.additions = diff.additions;
    change.deletions = diff.deletions;
    change.unified = toUnifiedDiff(change.path, change.before, next);
    change.notes = `${change.notes || ''} Repaired: ${String(parsed.notes || '').slice(0, 200)}`.trim();
    repaired += 1;
    if (previous !== next) event(task, 'repairing', `Repaired ${change.path}.`, { path: change.path });
  }

  await Store.saveTask(task);
  if (repaired) await test(env, task);
  return task;
}

/* --------------------------------- the runner ----------------------------- */

/**
 * Advance a task as far as it can go without user input. Safe to call
 * repeatedly: it always resumes from the persisted state.
 */
export async function advance(env, taskId, { session = null } = {}) {
  let task = await Store.getTask(taskId);
  if (!task) throw Object.assign(new Error('Task not found.'), { code: CODES.not_found });
  if (['completed', 'failed', 'cancelled', 'awaiting_plan_review', 'awaiting_review'].includes(task.state)) {
    return task;                                       // blocked on the user, or finished
  }

  try {
    if (task.state === 'queued' || !task.context.files?.length) {
      task = await analyze(env, task, { session });
    }
    if (!task.plan) {
      task = await plan(env, task, { session });
      if (task.state === 'failed') return task;
      if (task.autonomy === 'review-plan') {
        event(task, 'awaiting_plan_review', 'The plan is ready for your approval.');
        await Store.saveTask(task);
        return task;
      }
    }
    if (!task.changes.length) {
      task = await edit(env, task, { session });
      if (task.state === 'failed') return task;
    }

    // Ensure the working branch exists before tests, so the review step can
    // show exactly where the work will land.
    await ensureBranch(env, task, { session });

    if (!task.tests?.ran && !task.tests?.skipped) {
      task = await test(env, task);
    }

    const failedChecks = (task.tests?.checks || []).filter(c => !c.ok);
    if (failedChecks.length) {
      const maxAttempts = Number((await Store.getSettings()).tasks?.maxRepairAttempts ?? 2);
      if (task.repairAttempts < maxAttempts) {
        task = await repair(env, task, { session });
      }
    }

    // Optional second-opinion review when a different eligible model exists.
    if (!task.review && task.changes.length) {
      try {
        const review = await Router.reviewWithSecondModel(env, {
          primaryProvider: task.plan?.provider,
          output: task.changes.map(c => `### ${c.path}\n${c.unified}`).join('\n\n').slice(0, 24_000),
          instructions: 'You are reviewing a proposed code change. Reply with at most five bullets: correctness risks, missed cases, and anything that should be tested. No praise, no preamble.',
          task: 'review',
        });
        task.review = review;
        if (review?.text) event(task, task.state, `Reviewed by ${review.providerLabel}.`, { provider: review.provider });
      } catch { /* review is optional and never blocks the task */ }
    }

    const stillFailing = (task.tests?.checks || []).filter(c => !c.ok);
    if (task.autonomy === 'full' && !stillFailing.length) {
      return commit(env, task, { session });
    }

    event(task, 'awaiting_review', stillFailing.length
      ? 'Changes are ready, but checks are still failing.'
      : 'Changes are ready for your review.');
    await Store.saveTask(task);
    return task;
  } catch (err) {
    task.error = { code: err?.code || CODES.unknown, message: String(err?.message || err) };
    event(task, 'failed', String(err?.message || err), { code: err?.code || CODES.unknown });
    await Store.saveTask(task);
    return task;
  }
}

/**
 * Commit the reviewed changes to the task branch. This is the only path that
 * writes to GitHub, and it is only ever called after an explicit user action.
 * It never touches the base branch.
 */
export async function commit(env, taskId, { session = null, message = '' } = {}) {
  const task = await Store.getTask(taskId);
  if (!task) throw Object.assign(new Error('Task not found.'), { code: CODES.not_found });
  if (!task.changes?.length) {
    throw Object.assign(new Error('There are no changes to commit.'), { code: CODES.bad_request });
  }
  if (!task.branch) await ensureBranch(env, task, { session });

  const commitMessage = String(message || '').trim()
    || `${task.plan?.summary || task.prompt.slice(0, 72)}\n\nRequested in JARVIS STUDIO task ${task.id}.`;

  const results = await GitHub.commitFiles(
    env, task.repo, task.branch, commitMessage,
    task.changes.map(c => ({ path: c.path, content: c.after, mode: c.mode === 'delete' ? 'delete' : 'write' })),
    { session },
  );

  task.result = {
    committed: true,
    branch: task.branch,
    baseBranch: task.baseBranch,
    message: commitMessage,
    files: results,
    committedAt: Date.now(),
  };
  event(task, 'completed', `Committed ${results.length} file(s) to ${task.branch}.`);
  await Store.saveTask(task);
  return task;
}

/** Open a pull request for a committed task. Never merges anything. */
export async function openPullRequest(env, taskId, { session = null, title = '', body = '' } = {}) {
  const task = await Store.getTask(taskId);
  if (!task) throw Object.assign(new Error('Task not found.'), { code: CODES.not_found });
  if (!task.result?.committed) {
    throw Object.assign(new Error('Commit the changes before opening a pull request.'), { code: CODES.bad_request });
  }

  const pr = await GitHub.openPullRequest(env, task.repo, {
    title: String(title || '').trim() || task.plan?.summary || task.prompt.slice(0, 72),
    body: String(body || '').trim() || [
      task.plan?.summary || '',
      '',
      `Requested in JARVIS STUDIO: ${task.prompt}`,
      '',
      '### Changed files',
      ...task.changes.map(c => `- \`${c.path}\` (+${c.additions} −${c.deletions})`),
      '',
      task.tests?.ran
        ? `### Checks\n${task.tests.checks.map(c => `- ${c.label}: ${c.ok ? 'passed' : `failed (exit ${c.exitCode})`}`).join('\n')}`
        : '### Checks\nNo checks were executed for this task.',
    ].join('\n'),
    head: task.branch,
    base: task.baseBranch,
  }, { session });

  task.result.pr = pr;
  event(task, 'completed', `Pull request #${pr.number} opened.`, { url: pr.url });
  await Store.saveTask(task);
  return task;
}

export async function cancel(taskId) {
  const task = await Store.getTask(taskId);
  if (!task) throw Object.assign(new Error('Task not found.'), { code: CODES.not_found });
  if (['completed', 'failed', 'cancelled'].includes(task.state)) return task;
  event(task, 'cancelled', 'Cancelled. No files were changed on GitHub.');
  await Store.saveTask(task);
  return task;
}

export async function remove(taskId) { return Store.deleteTask(taskId); }

/** A compact list for the UI (tasks can carry a lot of file content). */
export function summarise(task) {
  const additions = (task.changes || []).reduce((sum, c) => sum + (c.additions || 0), 0);
  const deletions = (task.changes || []).reduce((sum, c) => sum + (c.deletions || 0), 0);
  return {
    id: task.id,
    repo: task.repo,
    branch: task.branch,
    baseBranch: task.baseBranch,
    prompt: task.prompt,
    state: task.state,
    stateLabel: STATE_LABELS[task.state] || task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    fileCount: task.changes?.length || 0,
    additions,
    deletions,
    repairAttempts: task.repairAttempts || 0,
    hasPlan: Boolean(task.plan),
    hasReview: Boolean(task.review?.text),
    testsRan: Boolean(task.tests?.ran),
    testsPassed: task.tests?.ran ? (task.tests.checks || []).every(c => c.ok) : null,
    committed: Boolean(task.result?.committed),
    pr: task.result?.pr || null,
    error: task.error || null,
  };
}
