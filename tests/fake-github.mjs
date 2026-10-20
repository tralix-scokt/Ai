/* ==========================================================================
   tests/fake-github.mjs — a local double for the GitHub REST API.

   Implements just the endpoints server/github.js uses, and records every
   request so a test can assert *what* was written and where. It never talks
   to github.com, and no credential is involved.

   Usage:
     const gh = startFakeGithub();        // installs a global fetch wrapper
     ...                                  // run the code under test
     gh.stop();                           // restore the original fetch
     gh.state.requests                    // [{ method, path, body }]
   ========================================================================== */

const BASE = 'https://api.github.com';

const base64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');

export function startFakeGithub({ files = {}, repos = null, branches = null, fail = {} } = {}) {
  const state = {
    requests: [],
    writes: [],                       // mutating calls: { method, path, branch }
    files: new Map(Object.entries(files)),
    createdBranches: [],
    pulls: [],
    fail,                             // e.g. { 'POST /repos/octo/demo/pulls': 422 }
  };

  const original = globalThis.fetch;

  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  const notFound = () => json({ message: 'Not Found' }, 404);

  function handle(url, init = {}) {
    const target = new URL(url);
    if (target.origin !== BASE) return null;                 // not ours

    const method = (init.method || 'GET').toUpperCase();
    const path = target.pathname;
    const body = init.body ? JSON.parse(init.body) : null;

    state.requests.push({ method, path, body, search: target.search });
    if (method !== 'GET') {
      state.writes.push({ method, path, branch: body?.branch || body?.ref || body?.base || '' });
    }

    const key = `${method} ${path}`;
    if (state.fail[key]) return json({ message: `forced failure ${state.fail[key]}` }, state.fail[key]);

    /* ---- identity ---- */
    if (path === '/user' && method === 'GET') {
      return json({ login: 'octocat', name: 'Octo Cat', avatar_url: '' });
    }

    /* ---- repositories ---- */
    if (path === '/user/repos' && method === 'GET') {
      const list = repos || [{
        id: 1,
        full_name: 'octo/demo',
        name: 'demo',
        owner: { login: 'octo' },
        private: false,
        default_branch: 'main',
        description: 'demo repository',
        language: 'JavaScript',
        pushed_at: new Date().toISOString(),
        permissions: { push: true, pull: true, admin: false },
      }];
      return json(list);
    }

    const branchMatch = path.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/branches$/);
    if (branchMatch && method === 'GET') {
      const list = branches || [{ name: 'main', commit: { sha: 'aaa111' }, protected: true },
        { name: 'develop', commit: { sha: 'bbb222' }, protected: false }];
      return json(list);
    }

    const treeMatch = path.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/git\/trees\/HEAD$/);
    if (treeMatch && method === 'GET') {
      return json({
        tree: [...state.files.entries()].map(([filePath, content]) => ({
          path: filePath,
          type: 'blob',
          size: Buffer.byteLength(content),
        })),
      });
    }

    const contentsMatch = path.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/contents\/(.+)$/);
    if (contentsMatch) {
      const filePath = decodeURIComponent(contentsMatch[2]);
      if (method === 'GET') {
        const content = state.files.get(filePath);
        if (content === undefined) return notFound();
        return json({ path: filePath, sha: `sha-${filePath}`, size: Buffer.byteLength(content), content: base64(content), encoding: 'base64' });
      }
      if (method === 'PUT') {
        const next = Buffer.from(String(body?.content || ''), 'base64').toString('utf8');
        const created = !state.files.has(filePath);
        state.files.set(filePath, next);
        return json({ content: { sha: `sha-${filePath}-new`, path: filePath }, commit: { sha: 'ccc333' } }, created ? 201 : 200);
      }
      if (method === 'DELETE') {
        state.files.delete(filePath);
        return json({ commit: { sha: 'ddd444' } }, 200);
      }
    }

    const refMatch = path.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/git\/ref\/heads\/(.+)$/);
    if (refMatch && method === 'GET') {
      const name = decodeURIComponent(refMatch[2]);
      if (name === 'main') return json({ object: { sha: 'aaa111' } });
      if (name === 'develop') return json({ object: { sha: 'bbb222' } });
      return notFound();
    }

    if (path.endsWith('/git/refs') && method === 'POST') {
      const ref = String(body?.ref || '');
      const name = ref.replace('refs/heads/', '');
      if (state.createdBranches.includes(name)) {
        return json({ message: 'Reference already exists' }, 422);
      }
      state.createdBranches.push(name);
      return json({ ref, object: { sha: body?.sha } }, 201);
    }

    if (path.endsWith('/pulls') && method === 'POST') {
      const pr = {
        number: state.pulls.length + 7,
        html_url: `https://github.com/octo/demo/pull/${state.pulls.length + 7}`,
        state: 'open',
        title: body?.title,
        base: { ref: body?.base },
        head: { ref: body?.head },
      };
      state.pulls.push(pr);
      return json(pr, 201);
    }

    const compareMatch = path.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/compare\/(.+)$/);
    if (compareMatch && method === 'GET') {
      return json({ status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, files: [] });
    }

    return notFound();
  }

  globalThis.fetch = async (url, init = {}) => {
    const target = typeof url === 'string' ? url : url?.url || String(url);
    if (target.startsWith(BASE)) {
      const stub = handle(target, init);
      if (stub) return stub;
    }
    return original(url, init);
  };

  return {
    state,
    stop() { globalThis.fetch = original; },
    file(path) { return state.files.get(path); },
    wroteTo(fragment) {
      return state.writes.some(w => w.path.includes(fragment));
    },
  };
}
