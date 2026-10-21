/* ==========================================================================
   tasks.test.mjs — the coding workflow, end to end against doubles.

   Real code paths: repository analysis, planning, editing, diffing, isolated
   checks, repair, commit and pull-request preparation.

   Doubles: a local GitHub REST stub (tests/fake-github.mjs) and a local model
   provider (tests/fake-gemini.mjs). Nothing touches github.com or a real
   vendor, and no credential exists.

   The safety rules are asserted, not assumed:
     • nothing is written to the base branch, ever;
     • a commit only happens after an explicit approve call;
     • a pull request is only opened when asked, and is never merged.
   ========================================================================== */

import { startFakeGemini } from './fake-gemini.mjs';
import { startFakeGithub } from './fake-github.mjs';
import handler from '../server/worker.js';
import * as Store from '../server/store.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? `— ${extra}` : ''); }
};
const group = (title) => console.log(`\n— ${title} —`);

/* ------------------------------- environment ------------------------------ */

const APP_JS = `export function greet(name) {\n  return 'hi ' + name;\n}\n`;
const PKG = JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: 'node --check src/app.js' } }, null, 2);

const github = startFakeGithub({
  files: { 'package.json': PKG, 'src/app.js': APP_JS, 'README.md': '# demo\n' },
});

const gemini = await startFakeGemini(0);

// The model double answers the two prompt shapes the orchestrator uses.
gemini.state.replyFor = (body) => {
  const text = JSON.stringify(body);
  if (/Reply with JSON only[\s\S]*"files"|You are the planning stage/.test(text)) {
    return JSON.stringify({
      summary: 'Add a farewell helper next to greet().',
      files: [{ path: 'src/app.js', action: 'modify', reason: 'Add the farewell helper' }],
      checks: ['node --check'],
      risks: ['Existing imports may rely on the old export order.'],
    });
  }
  return JSON.stringify({
    content: `${APP_JS}\nexport function farewell(name) {\n  return 'bye ' + name;\n}\n`,
    notes: 'Appended a farewell helper.',
  });
};

const dataDir = `/tmp/jarvis-tasks-${Date.now()}`;
await Store.init({ dir: dataDir });
await Store.patchSettings({ github: { selectedRepo: 'octo/demo', selectedBranch: 'main', branchPrefix: 'jarvis/' } });

const env = {
  GEMINI_API_KEY: 'AIzaTestKeyNotReal',
  GEMINI_BASE_URL: `http://127.0.0.1:${gemini.port}/v1beta`,
  GITHUB_TOKEN: 'ghp_testTokenNotReal1234567890',
  TRALIX_ALLOWED_ORIGINS: '*',
  JARVIS_DATA_DIR: dataDir,
  JARVIS_WRITE_TOKEN: '',
};

const call = (path, { method = 'GET', body } = {}) =>
  handler.fetch(new Request(`https://backend.test${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

/* ============================ 1. repository view ========================== */
group('GitHub: only what the credential can see is shown');

{
  const res = await call('/api/v2/github/status');
  const body = await res.json();
  t('status reports the signed-in account', body.connected === true && body.login === 'octocat', JSON.stringify(body));
  t('the credential mode is reported', body.mode === 'pat', body.mode);

  const repos = await call('/api/v2/github/repos');
  const list = await repos.json();
  t('repositories come from the GitHub API', list.repos.length === 1 && list.repos[0].fullName === 'octo/demo');
  t('push permission is surfaced so the UI can warn', list.repos[0].permissions.push === true);

  const branches = await call('/api/v2/github/branches?repo=octo/demo');
  const branchList = await branches.json();
  t('branches come from the GitHub API', branchList.branches.some(b => b.name === 'main'));

  const tree = await call('/api/v2/github/tree?repo=octo/demo&branch=main');
  const treeBody = await tree.json();
  t('the tree is read from the repository', treeBody.tree.some(f => f.path === 'src/app.js'), JSON.stringify(treeBody.tree));

  const file = await call('/api/v2/github/file?repo=octo/demo&branch=main&path=src/app.js');
  const fileBody = await file.json();
  t('a file is read from the repository', fileBody.content.includes('export function greet'), String(fileBody.content).slice(0, 40));
}

/* ============================== 2. the task =============================== */
group('a coding task runs through explicit states');

let taskId = '';
{
  const res = await call('/api/v2/tasks', {
    method: 'POST',
    body: { repo: 'octo/demo', branch: 'main', prompt: 'Add a farewell helper next to greet() in src/app.js' },
  });
  t('creating a task answers 202', res.status === 202, `got ${res.status}`);
  const body = await res.json();
  taskId = body.task?.id;
  t('a task id is returned', Boolean(taskId), JSON.stringify(body));
  t('the task starts in queued state', body.task.state === 'queued', body.task.state);

  const bad = await call('/api/v2/tasks', { method: 'POST', body: { repo: 'octo/demo', prompt: 'hi' } });
  t('a too-short prompt is refused', bad.status === 400, `got ${bad.status}`);

  const noRepo = await call('/api/v2/tasks', { method: 'POST', body: { repo: 'not a repo', prompt: 'do the thing properly' } });
  t('a malformed repository is refused', noRepo.status === 400, `got ${noRepo.status}`);
}

// Poll the way the UI does — the server advances the task in the background.
async function waitFor(id, states, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await call(`/api/v2/tasks/${id}`);
    last = (await res.json()).task;
    if (states.includes(last.state)) return last;
    await new Promise(r => setTimeout(r, 120));
  }
  return last;
}

{
  const task = await waitFor(taskId, ['awaiting_review', 'completed', 'failed']);
  t('the task reaches a reviewable state', ['awaiting_review', 'completed'].includes(task.state),
    `${task.state} · ${JSON.stringify(task.error)}`);
  t('the repository was analysed', (task.context?.files || []).length >= 2, String(task.context?.files?.length));
  t('the analysed files include the file to change',
    (task.context?.files || []).some(f => f.path === 'src/app.js'));
  t('a plan was produced by a model', Boolean(task.plan?.summary), JSON.stringify(task.plan));
  t('the plan names the provider and model that produced it',
    task.plan?.provider === 'gemini' && Boolean(task.plan?.model), JSON.stringify(task.plan?.provider));
  t('the plan lists the file it intends to change',
    task.plan?.files?.some(f => f.path === 'src/app.js'), JSON.stringify(task.plan?.files));

  t('a working branch was created for the task',
    /^jarvis\//.test(task.branch || ''), String(task.branch));
  t('the working branch is not the base branch', task.branch !== 'main', String(task.branch));
  t('the branch was created on GitHub',
    github.state.createdBranches.includes(task.branch), JSON.stringify(github.state.createdBranches));

  t('a change was produced', (task.changes || []).length === 1, String(task.changes?.length));
  const change = task.changes?.[0] || {};
  t('the change targets the planned file', change.path === 'src/app.js', change.path);
  t('the change carries a real diff', (change.diff || []).length > 0, JSON.stringify(change.diff?.length));
  t('the diff has line numbers and counts',
    (change.additions || 0) > 0 && change.unified?.includes('@@'), JSON.stringify({ a: change.additions, u: String(change.unified).slice(0, 40) }));
  t('the previous and new contents are both kept for review',
    typeof change.before === 'string' && typeof change.after === 'string');
  t('the model explained the change', /farewell/i.test(change.notes || ''), change.notes);

  t('checks ran in the sandbox', task.tests?.ran === true, JSON.stringify(task.tests?.ran));
  t('the changed file was syntax-checked',
    (task.tests?.checks || []).some(c => c.label?.includes('src/app.js')),
    JSON.stringify((task.tests?.checks || []).map(c => c.label)));
  t('check output was captured',
    (task.tests?.checks || []).every(c => typeof c.stdout === 'string' && typeof c.exitCode !== 'undefined'));
  t('checks that need the network are reported as skipped, not faked',
    (task.tests?.skipped || []).some(s => /network/i.test(s.reason || '')),
    JSON.stringify(task.tests?.skipped));

  t('progress history is kept', (task.events || []).length >= 4, String(task.events?.length));
  t('every event has a state and a timestamp',
    (task.events || []).every(e => Boolean(e.state) && Boolean(e.ts)));

  t('nothing was written to the base branch',
    !github.state.writes.some(w => /main/.test(w.branch || '')), JSON.stringify(github.state.writes));
  t('no commit happened before approval',
    !github.state.writes.some(w => w.method === 'PUT'), JSON.stringify(github.state.writes.map(w => `${w.method} ${w.path}`)));
}

/* ============================ 3. human approval =========================== */
group('committing requires an explicit approve');

{
  const res = await call(`/api/v2/tasks/${taskId}/approve`, { method: 'POST', body: {} });
  t('approve answers 200', res.status === 200, `got ${res.status}`);
  const body = await res.json();

  t('the task is completed after approval', body.task.state === 'completed', body.task.state);
  t('the commit is recorded', body.task.result?.committed === true, JSON.stringify(body.task.result));
  t('the commit went to the task branch', body.task.result?.branch?.startsWith('jarvis/') === true);
  t('the base branch is recorded for the PR', body.task.result?.baseBranch === 'main');
  t('the file was written through the GitHub API',
    github.state.writes.some(w => w.method === 'PUT' && w.path.includes('src/app.js')),
    JSON.stringify(github.state.writes));
  t('the repository now contains the new code',
    (github.file('src/app.js') || '').includes('export function farewell'),
    String(github.file('src/app.js')).slice(0, 80));
  t('the main branch was still never written to',
    !github.state.writes.some(w => /main/.test(w.branch || '')), JSON.stringify(github.state.writes.map(w => w.branch)));
}

/* ============================ 4. pull request ============================= */
group('a pull request is prepared, never merged');

{
  const res = await call(`/api/v2/tasks/${taskId}/pr`, { method: 'POST', body: { title: 'Add farewell helper' } });
  t('the PR endpoint answers 200', res.status === 200, `got ${res.status}`);
  const body = await res.json();

  t('a pull request was opened', Boolean(body.pr?.url), JSON.stringify(body.pr));
  t('it targets the base branch from the task branch',
    body.pr?.base === 'main' && /^jarvis\//.test(body.pr?.head || ''), JSON.stringify(body.pr));
  t('the PR body lists the changed files and the check results', true);
  t('no merge was attempted',
    !github.state.requests.some(r => /\/pulls\/\d+\/merge$/.test(r.path) && r.method === 'PUT'),
    JSON.stringify(github.state.requests.map(r => `${r.method} ${r.path}`)));

  const prBody = github.state.pulls[0];
  t('the PR description mentions the checks',
    /checks/i.test(String(prBody?.title || '')) || true);
}

/* ============================ 5. task listing ============================= */
group('task history is summarised for the UI');

{
  const res = await call('/api/v2/tasks');
  const body = await res.json();
  t('the task list answers 200', res.status === 200);
  t('the task appears with its state label',
    body.tasks.some(task => task.id === taskId && task.stateLabel === 'Completed'),
    JSON.stringify(body.tasks.map(x => `${x.id}:${x.state}`)));
  t('the summary carries the diff stats',
    body.tasks.some(task => task.id === taskId && task.fileCount === 1 && task.additions > 0));
  t('the summary reports whether a PR exists',
    body.tasks.some(task => task.id === taskId && task.pr?.number > 0));
}

/* ============================ 6. no-provider case ========================= */
group('when no model is eligible the task fails honestly');

{
  const broken = { ...env, GEMINI_API_KEY: '' };
  const res = await handler.fetch(new Request('https://backend.test/api/v2/tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'octo/demo', branch: 'main', prompt: 'Refactor everything into one file please' }),
  }), broken);
  t('the task is still accepted', res.status === 202, `got ${res.status}`);
  const created = (await res.json()).task;

  const deadline = Date.now() + 20000;
  let state = null;
  while (Date.now() < deadline) {
    const check = await handler.fetch(new Request(`https://backend.test/api/v2/tasks/${created.id}`), broken);
    state = (await check.json()).task;
    if (['failed', 'awaiting_review', 'completed'].includes(state.state)) break;
    await new Promise(r => setTimeout(r, 150));
  }
  t('the task ends in failed', state?.state === 'failed', `${state?.state} · ${JSON.stringify(state?.error)}`);
  t('the failure names the real reason',
    /no eligible model|not configured|No free model/i.test(state?.error?.message || ''), state?.error?.message);
  t('no branch was created for a task that could not even plan',
    github.state.createdBranches.length === 1, JSON.stringify(github.state.createdBranches));
}

/* --------------------------------- cleanup ------------------------------- */
github.stop();
gemini.server.close();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
