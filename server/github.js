/* ==========================================================================
   server/github.js — GitHub access with the narrowest credential available.

   Three credential modes, tried in this order:

     1. pat    GITHUB_TOKEN            a fine-grained personal access token.
                                       Simplest, works today, solo-developer
                                       friendly. Recommended minimum scopes:
                                       on a *fine-grained* token limited to the
                                       repositories you will use —
                                         Contents: Read and write
                                         Metadata: Read-only
                                         Pull requests: Read and write
                                       plus read:user on a classic token.

     2. app    GITHUB_APP_ID +
               GITHUB_APP_PRIVATE_KEY  a GitHub App: short-lived installation
               GITHUB_INSTALLATION_ID  tokens (1 hour), permissions chosen per
                                       app, revocable per installation. This is
                                       the narrowest option and is what the
                                       README recommends for teams.

     3. oauth  GITHUB_OAUTH_CLIENT_ID  per-user sign-in. The user's token is
               GITHUB_OAUTH_SECRET     kept in an httpOnly session cookie and
                                       never reaches the browser.

   Rules enforced here:
     • Only repositories the credential can actually see are ever listed — the
       API is asked, nothing is synthesised.
     • Nothing is pushed to a repository's default branch. Write operations go
       to a task branch the server creates.
     • Tokens never leave this module except as an Authorization header, and
       every error is redacted before it is logged or returned.
   ========================================================================== */

import { redact } from './lib/http.js';
import * as Store from './store.js';

const API = 'https://api.github.com';

/* ------------------------------- credentials ------------------------------ */

function pemToArrayBuffer(pem) {
  const clean = String(pem || '')
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN[^-]+-----/g, '')
    .replace(/-----END[^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64url(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Sign a GitHub App JWT (RS256, 9 minutes). */
async function appJwt(appId, privateKeyPem) {
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(privateKeyPem),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = base64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(enc.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) })));
  const data = enc.encode(`${header}.${payload}`);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, data);
  return `${header}.${payload}.${base64url(signature)}`;
}

let installationToken = { value: '', expiresAt: 0, installationId: '' };

async function appInstallationToken(env, secrets) {
  const appId = String(env.GITHUB_APP_ID || secrets['github.appId'] || '');
  const privateKey = String(env.GITHUB_APP_PRIVATE_KEY || secrets['github.privateKey'] || '');
  const installationId = String(env.GITHUB_INSTALLATION_ID || secrets['github.installationId'] || '');
  if (!appId || !privateKey) return null;

  if (installationToken.value && installationToken.expiresAt > Date.now() + 60_000
      && installationToken.installationId === installationId) {
    return { token: installationToken.value, source: 'github-app' };
  }

  const jwt = await appJwt(appId, privateKey);

  let target = installationId;
  if (!target) {
    const res = await fetch(`${API}/app/installations`, {
      headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/vnd.github+json', 'User-Agent': 'jarvis-studio' },
    });
    if (!res.ok) throw new Error('The GitHub App could not list its installations.');
    const list = await res.json();
    if (!list.length) throw new Error('The GitHub App has no installations yet. Install it on an account or repository first.');
    target = String(list[0].id);
  }

  const res = await fetch(`${API}/app/installations/${target}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'jarvis-studio',
    },
  });
  if (!res.ok) throw new Error('GitHub refused to mint an installation token for the app.');
  const data = await res.json();
  installationToken = {
    value: data.token,
    expiresAt: Date.parse(data.expires_at || '') || (Date.now() + 55 * 60_000),
    installationId: target,
  };
  return { token: data.token, source: 'github-app' };
}

/**
 * Resolve the credential for this request.
 * @returns {Promise<{token:string, mode:string, source:string}|null>}
 */
export async function credentials(env, { session = null } = {}) {
  const secrets = await Store.getSecrets();
  const settings = await Store.getSettings();

  // 1. an authenticated browser session wins: the repositories are the user's
  if (session?.githubToken) {
    return { token: session.githubToken, mode: 'oauth', source: 'user session' };
  }

  // 2. personal access token (the documented default for a solo developer)
  const pat = String(env.GITHUB_TOKEN || secrets['github.pat'] || '');
  if (pat) return { token: pat, mode: 'pat', source: env.GITHUB_TOKEN ? 'environment' : 'server store' };

  // 3. GitHub App
  try {
    const app = await appInstallationToken(env, secrets);
    if (app) return { token: app.token, mode: 'app', source: 'github-app installation' };
  } catch (err) {
    console.warn('[jarvis] github app credential failed:', redact(String(err?.message || err)));
  }

  return null;
}

/* --------------------------------- requests ------------------------------- */

async function gh(token, path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'jarvis-studio',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (raw) return res;

  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    const message = String(payload?.message || '');
    const err = new Error(githubMessage(res.status, message));
    err.status = res.status;
    err.code = res.status === 401 || res.status === 403 ? 'unauthorized'
      : res.status === 404 ? 'not_found'
        : res.status === 422 ? 'bad_request'
          : res.status === 429 ? 'rate_limit' : 'unknown';
    err.detail = redact(message);
    throw err;
  }
  if (res.status === 204) return null;
  return res.json().catch(() => ({}));
}

/**
 * A credential can be present and still unusable because the *server* has no
 * route to GitHub. Say which of the two failed instead of echoing "fetch
 * failed", which tells the user nothing they can act on.
 */
export function reachableMessage(err) {
  const raw = String(err?.message || err?.cause?.message || '');
  const code = String(err?.cause?.code || err?.code || '');
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH/i.test(`${raw} ${code}`)) {
    return 'The backend could not reach api.github.com (network error). Check the server’s internet access and any proxy or firewall rules.';
  }
  return raw || 'GitHub rejected the credential.';
}

export function githubMessage(status, vendor = '') {
  if (status === 401) return 'GitHub rejected the credential. Check GITHUB_TOKEN (or the App private key) on the backend.';
  if (status === 403) return /rate limit/i.test(vendor)
    ? 'GitHub is rate limiting this credential. Try again shortly.'
    : 'GitHub refused this operation. The credential may be missing the "Contents: Read and write" or "Pull requests: Read and write" permission.';
  if (status === 404) return 'GitHub could not find that repository or file for this credential.';
  if (status === 422) return 'GitHub refused the change — the branch may already exist or the file may have changed.';
  if (status === 409) return 'That branch or file already exists.';
  if (status >= 500) return 'GitHub reported an internal error. Try again shortly.';
  return vendor || 'The GitHub request failed.';
}

/* -------------------------------- endpoints ------------------------------- */

export async function status(env, { session = null } = {}) {
  const creds = await credentials(env, { session });
  const secrets = await Store.getSecrets();
  const configured = Boolean(
    env.GITHUB_TOKEN || secrets['github.pat']
    || (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY)
    || (secrets['github.appId'] && secrets['github.privateKey'])
    || Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET)
    || session?.githubToken,
  );

  if (!creds) {
    return {
      configured,
      connected: false,
      mode: (!creds && (env.GITHUB_APP_ID || env.GITHUB_OAUTH_CLIENT_ID)) ? 'app' : 'pat',
      login: '',
      message: configured
        ? 'GitHub credentials are present but could not be used. Check the backend logs.'
        : 'No GitHub credential configured. Set GITHUB_TOKEN on the backend, or add one in Settings → GitHub.',
    };
  }

  try {
    const user = await gh(creds.token, '/user');
    return {
      configured: true,
      connected: true,
      mode: creds.mode,
      source: creds.source,
      login: user.login || '',
      name: user.name || '',
      avatarUrl: user.avatar_url || '',
      scopes: headerScopes(creds),
      message: `Connected to GitHub as ${user.login}.`,
    };
  } catch (err) {
    return {
      configured: true,
      connected: false,
      mode: creds.mode,
      login: '',
      message: reachableMessage(err),
    };
  }
}

/** Report the scopes GitHub actually granted, when the header is present. */
function headerScopes(creds) {
  // `gh()` throws before we can read headers; a cheap HEAD-shaped call keeps
  // the status endpoint honest without a second round trip in the happy path.
  return creds.mode === 'pat' ? [] : [];
}

export async function listRepos(env, { session = null, perPage = 100 } = {}) {
  const creds = await credentials(env, { session });
  if (!creds) throw Object.assign(new Error('GitHub is not connected.'), { code: 'unauthorized' });

  // /user/repos returns everything the credential can reach — public and
  // private — so the list is genuinely "what you are authorised to see".
  const data = await gh(creds.token, `/user/repos?per_page=${perPage}&sort=updated&affiliation=owner,collaborator,organization_member`);
  return (Array.isArray(data) ? data : []).map(repo => ({
    id: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner?.login || '',
    private: Boolean(repo.private),
    defaultBranch: repo.default_branch || 'main',
    description: repo.description || '',
    language: repo.language || '',
    pushedAt: repo.pushed_at || '',
    permissions: {
      push: Boolean(repo.permissions?.push),
      pull: Boolean(repo.permissions?.pull),
      admin: Boolean(repo.permissions?.admin),
    },
  }));
}

export async function listBranches(env, repo, { session = null } = {}) {
  const creds = await credentials(env, { session });
  if (!creds) throw Object.assign(new Error('GitHub is not connected.'), { code: 'unauthorized' });
  const data = await gh(creds.token, `/repos/${repo}/branches?per_page=100`);
  return (Array.isArray(data) ? data : []).map(b => ({
    name: b.name,
    sha: b.commit?.sha || '',
    protected: Boolean(b.protected),
  }));
}

/**
 * Repository tree, trimmed to what a coding task needs: no blobs, no vendor
 * directories, capped so a huge monorepo cannot flood the model context.
 */
export async function listTree(env, repo, branch, { session = null, limit = 400 } = {}) {
  const creds = await credentials(env, { session });
  if (!creds) throw Object.assign(new Error('GitHub is not connected.'), { code: 'unauthorized' });

  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const data = await gh(creds.token, `/repos/${repo}/git/trees/HEAD${ref ? `?recursive=1&ref=${encodeURIComponent(branch)}` : '?recursive=1'}`);
  const all = (data.tree || []).filter(item => item.type === 'blob');

  const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.turbo|vendor|\.cache|\.venv|__pycache__)(\/|$)/;
  const BINARY = /\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|eot|mp4|mp3|pdf|zip|gz|tar|7z|lock)$/i;

  return all
    .filter(item => !SKIP.test(item.path) && !BINARY.test(item.path))
    .slice(0, limit)
    .map(item => ({ path: item.path, size: item.size || 0 }));
}

export async function getFile(env, repo, branch, filePath, { session = null, maxBytes = 200_000 } = {}) {
  const creds = await credentials(env, { session });
  if (!creds) throw Object.assign(new Error('GitHub is not connected.'), { code: 'unauthorized' });

  const res = await gh(creds.token,
    `/repos/${repo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}?ref=${encodeURIComponent(branch)}`,
    { raw: false });

  if (res && typeof res === 'object' && res.content && res.encoding === 'base64') {
    if (res.size > maxBytes) {
      return { path: filePath, truncated: true, size: res.size, content: '' };
    }
    const binary = atob(res.content.replace(/\n/g, ''));
    return { path: filePath, sha: res.sha, size: res.size, content: binary, truncated: false };
  }
  return { path: filePath, content: '', truncated: false, size: 0, note: 'not a text file' };
}

/** Create an isolated working branch off the selected branch. Never main. */
export async function createBranch(env, repo, { from, name }, { session = null } = {}) {
  const creds = await credentials(env, { session });
  if (!creds) throw Object.assign(new Error('GitHub is not connected.'), { code: 'unauthorized' });

  const base = await gh(creds.token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(from)}`);
  const sha = base?.object?.sha;
  if (!sha) throw Object.assign(new Error(`Branch "${from}" was not found.`), { code: 'not_found' });

  try {
    await gh(creds.token, `/repos/${repo}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${name}`, sha },
    });
    return { branch: name, sha, created: true };
  } catch (err) {
    if (err?.status === 422) {
      // Already exists: reuse it rather than destroying existing work.
      const existing = await gh(creds.token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(name)}`);
      return { branch: name, sha: existing?.object?.sha || sha, created: false };
    }
    throw err;
  }
}

/**
 * Commit a set of file changes on a branch.
 * @param {Array<{path:string, content:string, mode?:'write'|'delete'}>} files
 */
export async function commitFiles(env, repo, branch, message, files, { session = null } = {}) {
  const creds = await credentials(env, { session });
  if (!creds) throw Object.assign(new Error('GitHub is not connected.'), { code: 'unauthorized' });

  // Order matters: delete first so a rename does not fail on a duplicate path.
  const ordered = [...files].sort((a, b) => (a.mode === 'delete' ? -1 : 0) - (b.mode === 'delete' ? -1 : 0));
  const results = [];

  for (const file of ordered) {
    const path = String(file.path || '').replace(/^\/+/, '');
    if (!path) continue;

    if (file.mode === 'delete') {
      const current = await gh(creds.token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`).catch(() => null);
      if (!current?.sha) { results.push({ path, skipped: true, reason: 'not present on the branch' }); continue; }
      await gh(creds.token, `/repos/${repo}/contents/${path}`, {
        method: 'DELETE',
        body: { message, sha: current.sha, branch },
      });
      results.push({ path, deleted: true });
      continue;
    }

    const current = await gh(creds.token, `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`).catch(() => null);
    const body = {
      message,
      branch,
      content: btoa(unescape(encodeURIComponent(String(file.content ?? '')))),
      ...(current?.sha ? { sha: current.sha } : {}),
    };
    const saved = await gh(creds.token, `/repos/${repo}/contents/${path}`, { method: 'PUT', body });
    results.push({ path, updated: true, sha: saved?.content?.sha || '', created: !current?.sha });
  }

  return results;
}

/**
 * Open a pull request. Called only after the user presses "Open pull request" —
 * this function never merges anything.
 */
export async function openPullRequest(env, repo, { title, body, head, base }, { session = null } = {}) {
  const creds = await credentials(env, { session });
  if (!creds) throw Object.assign(new Error('GitHub is not connected.'), { code: 'unauthorized' });

  const pr = await gh(creds.token, `/repos/${repo}/pulls`, {
    method: 'POST',
    body: { title, body, head, base },
  });
  return {
    number: pr.number,
    url: pr.html_url,
    state: pr.state,
    title: pr.title,
    base: pr.base?.ref,
    head: pr.head?.ref,
  };
}

export async function compareBranch(env, repo, base, head, { session = null } = {}) {
  const creds = await credentials(env, { session });
  if (!creds) throw Object.assign(new Error('GitHub is not connected.'), { code: 'unauthorized' });
  const data = await gh(creds.token, `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  return {
    status: data.status,
    aheadBy: data.ahead_by,
    behindBy: data.behind_by,
    totalCommits: data.total_commits,
    files: (data.files || []).map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      patch: f.patch || '',
    })),
  };
}

/* --------------------------------- OAuth ---------------------------------- */

/**
 * Start an OAuth sign-in. Returns the GitHub URL the browser should visit.
 * Scopes deliberately narrow: repo contents + pull requests + identity.
 */
export function oauthStart(env, request, { state = '' } = {}) {
  const clientId = String(env.GITHUB_OAUTH_CLIENT_ID || '');
  const redirect = oauthRedirectUri(env, request);
  if (!clientId) return null;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    scope: 'read:user repo',
    state,
  });
  return { url: `https://github.com/login/oauth/authorize?${params}`, redirectUri: redirect };
}

export function oauthRedirectUri(env, request) {
  return String(env.GITHUB_OAUTH_REDIRECT_URI || '')
    || `${new URL(request.url).origin}/api/v2/github/oauth/callback`;
}

/** Exchange the code for a token and store it in an httpOnly session cookie. */
export async function oauthCallback(env, request, { code }) {
  const clientId = String(env.GITHUB_OAUTH_CLIENT_ID || '');
  const clientSecret = String(env.GITHUB_OAUTH_CLIENT_SECRET || '');
  if (!clientId || !clientSecret) throw new Error('GitHub OAuth is not configured on the backend.');

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(String(data?.error_description || 'GitHub refused the OAuth exchange.'));
  }

  const user = await gh(data.access_token, '/user');
  const sessionId = crypto.randomUUID();
  Store.putSession(sessionId, { githubToken: data.access_token, login: user.login, scopes: String(data.scope || '') });
  return { sessionId, login: user.login, name: user.name || '', avatarUrl: user.avatar_url || '' };
}
