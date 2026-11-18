import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApi } from '../../src/api/server.js';
import { PullRequestService } from '../../src/integrations/pull-requests.js';
import type { SecretStore } from '../../src/security/secret-store.js';
import { git, WorkspaceManager } from '../../src/workspace/git.js';
import { fixture } from '../helpers.js';

const TOKEN = `github_pat_${'Fixture1'.repeat(6)}`;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
type Remote = { github?: { merged?: boolean; closed?: boolean; mergeable?: string; runs?: unknown[]; statuses?: unknown[]; threads?: unknown[]; down?: boolean }; drafts?: boolean; pulls: { number: number; head: string; base: string; draft: boolean; title: string; body: string }[]; posts: number; calls: string[] };

/** A project connected to a GitHub that is a local bare repository plus a recorded fake API. */
async function setup(options: { connected?: boolean } = {}) {
  const f = await fixture(); const bare = join(f.root, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  const values = new Map([['github-fixture-user', TOKEN]]);
  const secrets: SecretStore = { mode: 'vault', variable: name => `VAR_${name}`, locked: async () => false, get: async name => values.get(name), set: async (name, value) => { values.set(name, value); }, remove: async name => { values.delete(name); } };
  if (options.connected !== false) f.store.setProjectIntegrations('fixture', () => ({ github: { savedToken: 'github-fixture-user', repository: 'example-org/website', login: 'fixture-user', tokenKind: 'fine-grained', canPush: true, connectedAt: '2026-11-18T10:00:00.000Z', checkedAt: '2026-11-18T10:00:00.000Z' } }));
  const state: Remote = { pulls: [], posts: 0, calls: [] };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET'; state.calls.push(`${method} ${url}`);
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
    const path = url.replace('https://api.github.test/repos/example-org/website', '');
    const g = state.github ?? {};
    if (g.down && (url.endsWith('/graphql') || /\/(pulls\/\d+|commits\/)/.test(path))) return json({ message: 'Bad credentials' }, 401);
    if (url === 'https://api.github.test/graphql') { assert.deepEqual(JSON.parse(String(init!.body)).variables, { owner: 'example-org', name: 'website', number: 42 }); return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: g.threads ?? [] } } } } }); }
    if (/^\/pulls\/42$/.test(path)) return json({ number: 42, state: g.closed || g.merged ? 'closed' : 'open', merged: g.merged === true, draft: true, mergeable: g.mergeable === 'dirty' ? false : true, mergeable_state: g.mergeable ?? 'clean', head: { sha: 'f'.repeat(40) }, base: { ref: 'main' } });
    if (path.startsWith(`/commits/${'f'.repeat(40)}/check-runs`)) return json({ check_runs: g.runs ?? [] });
    if (path.startsWith(`/commits/${'f'.repeat(40)}/status`)) return json({ statuses: g.statuses ?? [] });
    if (path === '') return json({ default_branch: 'main' });
    if (path.startsWith('/branches')) return json([{ name: 'main' }, { name: 'develop' }, { name: 'devagents/old-task-00000000' }]);
    if (path.startsWith('/pulls?')) { const head = new URL(url).searchParams.get('head'); return json(state.pulls.filter(p => `example-org:${p.head}` === head).map(p => ({ number: p.number, html_url: `https://github.test/example-org/website/pull/${p.number}`, draft: p.draft, base: { ref: p.base } }))); }
    if (path === '/pulls' && method === 'POST') {
      state.posts += 1; const body = JSON.parse(String(init!.body));
      if (body.draft && state.drafts === false) return json({ message: 'Draft pull requests are not supported in this repository.' }, 422);
      if (body.base === 'missing') return json({ message: 'Validation Failed' }, 422);
      const pull = { number: 41 + state.pulls.length + 1, head: body.head, base: body.base, draft: body.draft, title: body.title, body: body.body }; state.pulls.push(pull);
      return json({ number: pull.number, html_url: `https://github.test/example-org/website/pull/${pull.number}`, draft: pull.draft, base: { ref: pull.base } }, 201);
    }
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  const pulls = new PullRequestService(f.store, secrets, { fetch: fetcher, githubApiUrl: 'https://api.github.test', remoteUrl: () => bare, now: () => new Date('2026-11-18T12:00:00Z') });
  f.service.onSubmitted(task => pulls.freeze(task.id, task.projectId));
  let count = 0;
  /** A task with one commit on its own branch, stored as completed. */
  const finished = async (request = 'Add input validation to the signup form') => {
    const task = f.service.submit({ projectId: 'fixture', request, mode: 'autonomous' }, `key-${count += 1}`);
    const workspace = await new WorkspaceManager(f.dataDir).create(f.store.project('fixture'), task.id, task.request);
    await writeFile(join(workspace.path, `change-${count}.txt`), 'changed\n');
    await git(workspace.path, ['add', '.']);
    await git(workspace.path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Change']);
    const commit = await git(workspace.path, ['rev-parse', 'HEAD']);
    const raw = new DatabaseSync(join(f.dataDir, 'test.db'));
    raw.prepare('UPDATE tasks SET state=?, data=? WHERE id=?').run('completed', JSON.stringify({ ...task, workspace, state: 'completed', outcome: { commit, summary: 'Validates the form.', repairCycles: 0 } }), task.id); raw.close();
    return { id: task.id, branch: workspace.branch, commit };
  };
  const remoteRef = (branch: string) => execFileSync('git', ['-C', bare, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  return { f, pulls, state, bare, finished, remoteRef, kinds: (id: string) => f.store.evidence(id).map(e => e.kind).filter(k => k.startsWith('pull-request')) };
}

test('a click pushes the task branch once and opens one draft pull request into the default branch', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.pulls.project('fixture'), { connected: true, repository: 'example-org/website', settings: { publish: 'off' } });
    const before = await s.finished();
    assert.equal(s.pulls.view(before.id).canPublish, false, 'a project that does not publish offers nothing');
    assert.deepEqual(s.pulls.save('fixture', { publish: 'ask' }).settings, { publish: 'ask' });
    assert.equal(s.pulls.view(before.id).canPublish, true, 'a click is offered for a task finished before the setting was turned on');
    const t = await s.finished();
    assert.deepEqual(s.pulls.view(t.id), { mode: 'ask', canPublish: true, publishing: false });
    const [first, second] = await Promise.all([s.pulls.publish(t.id, 'user'), s.pulls.publish(t.id, 'user')]);
    assert.equal(first, second, 'a second request joins the first');
    assert.deepEqual(first, { number: 42, url: 'https://github.test/example-org/website/pull/42', repository: 'example-org/website', branch: t.branch, base: 'main', commit: t.commit, draft: true, openedAt: '2026-11-18T12:00:00.000Z', trigger: 'user' });
    assert.equal(s.remoteRef(t.branch), t.commit);
    assert.deepEqual(s.state.pulls[0], { number: 42, head: t.branch, base: 'main', draft: true, title: 'Add input validation to the signup form', body: `Validates the form.\n\nOpened by DevAgents from task ${t.id}.` });
    assert.deepEqual(s.kinds(t.id), ['pull-request-settings', 'pull-request-pushed', 'pull-request-opened']);
    const { github, ...shown } = s.pulls.view(t.id);
    assert.deepEqual(shown, { mode: 'ask', canPublish: false, publishing: false, pullRequest: first }); assert.equal(github!.state, 'open');
    assert.equal(await s.pulls.publish(t.id, 'user').then(p => p.number), 42);
    assert.equal(s.state.posts, 1);
    assert.doesNotMatch(JSON.stringify(s.f.store.evidence(t.id)), /github_pat_/);
    assert.equal(execFileSync('git', ['-C', s.f.project, 'remote'], { encoding: 'utf8' }), '', 'the user\'s checkout gets no remote');
    assert.equal(execFileSync('git', ['-C', s.f.project, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), 'main');
  } finally { await s.f.cleanup(); }
});

test('an interrupted publish is finished without a second push or pull request', async () => {
  const s = await setup();
  try {
    s.pulls.save('fixture', { publish: 'ask', targetBranch: 'develop' });
    const t = await s.finished();
    execFileSync('git', ['-C', s.f.project, '-c', 'protocol.file.allow=always', 'push', '-q', s.bare, `${t.commit}:refs/heads/${t.branch}`]);
    s.state.pulls.push({ number: 7, head: t.branch, base: 'develop', draft: false, title: 'x', body: '' });
    const opened = await s.pulls.publish(t.id, 'user');
    assert.equal(opened.number, 7); assert.equal(opened.base, 'develop'); assert.equal(opened.draft, false);
    assert.equal(s.state.posts, 0);
    assert.deepEqual(s.kinds(t.id), ['pull-request-settings', 'pull-request-opened'], 'nothing was pushed again');
  } finally { await s.f.cleanup(); }
});

test('a branch that already holds other commits is left alone and the failure is recorded', async () => {
  const s = await setup();
  try {
    s.pulls.save('fixture', { publish: 'ask' });
    const t = await s.finished();
    const main = execFileSync('git', ['-C', s.f.project, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    execFileSync('git', ['-C', s.f.project, '-c', 'protocol.file.allow=always', 'push', '-q', s.bare, `${main}:refs/heads/${t.branch}`]);
    await assert.rejects(s.pulls.publish(t.id, 'user'), { code: 'branch_taken' });
    assert.equal(s.remoteRef(t.branch), main);
    const view = s.pulls.view(t.id);
    assert.equal(view.canPublish, true); assert.match(view.failure!.message, /already has a branch/); assert.equal(s.state.posts, 0);
  } finally { await s.f.cleanup(); }
});

test('a project set to automatic publishes finished tasks on its own, once', async () => {
  const s = await setup();
  try {
    s.pulls.save('fixture', { publish: 'auto', targetBranch: 'missing' });
    const waiting = s.f.service.submit({ projectId: 'fixture', request: 'Still planning', mode: 'autonomous' }, 'waiting');
    const t = await s.finished();
    await s.pulls.publishDue();
    assert.equal(s.state.posts, 2, 'draft and ready were both refused for a missing target');
    assert.match(s.pulls.view(t.id).failure!.message, /Check that missing exists/); assert.equal(s.pulls.view(t.id).failure!.trigger, 'setting');
    await s.pulls.publishDue();
    assert.equal(s.state.posts, 2, 'a failed publish waits for a click');
    assert.deepEqual(s.kinds(waiting.id), ['pull-request-settings']);
    // The task keeps the choice it started with; the project's later change applies to later tasks.
    s.pulls.save('fixture', { publish: 'auto' });
    const later = await s.finished('Second change');
    s.pulls.save('fixture', { publish: 'off' });
    s.state.drafts = false;
    await s.pulls.publishDue();
    const view = s.pulls.view(later.id);
    assert.equal(view.pullRequest!.trigger, 'setting'); assert.equal(view.pullRequest!.draft, false, 'opened as ready where drafts are unavailable'); assert.equal(view.pullRequest!.base, 'main');
    assert.equal(s.pulls.view(t.id).pullRequest, undefined);
  } finally { await s.f.cleanup(); }
});

test('settings need a connection, and the routes return the same views', async () => {
  const s = await setup({ connected: false });
  const server = createApi(s.f.service, 'test-token', { pullRequests: s.pulls });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(`${root}${path}`, { method, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as Record<string, any> };
  };
  try {
    assert.deepEqual((await call('/projects/fixture/pull-requests')).data, { connected: false, settings: { publish: 'off' } });
    assert.equal((await call('/projects/fixture/pull-requests', 'PUT', { publish: 'auto' })).data.error, 'not_connected');
    assert.equal((await call('/projects/fixture/pull-requests', 'PUT', { publish: 'auto', targetBranch: '../main' })).status, 400);
    s.f.store.setProjectIntegrations('fixture', () => ({ github: { savedToken: 'github-fixture-user', repository: 'example-org/website', login: 'fixture-user', tokenKind: 'fine-grained', canPush: true, connectedAt: '2026-11-18T10:00:00.000Z', checkedAt: '2026-11-18T10:00:00.000Z' } }));
    assert.deepEqual((await call('/projects/fixture/pull-requests', 'PUT', { publish: 'ask', targetBranch: 'develop' })).data.settings, { publish: 'ask', targetBranch: 'develop' });
    assert.deepEqual((await call('/projects/fixture/pull-requests/branches')).data, { branches: ['main', 'develop'], defaultBranch: 'main' });
    const t = await s.finished();
    assert.equal((await call(`/tasks/${t.id}/pull-request`)).data.canPublish, true);
    const published = await call(`/tasks/${t.id}/pull-request`, 'POST');
    assert.equal(published.status, 200); assert.equal(published.data.pullRequest.number, 42); assert.equal(published.data.pullRequest.base, 'develop');
    const draft = s.f.service.submit({ projectId: 'fixture', request: 'Not finished', mode: 'autonomous' }, 'draft');
    assert.equal((await call(`/tasks/${draft.id}/pull-request`, 'POST')).data.error, 'not_publishable');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await s.f.cleanup(); }
});

test('GitHub is read once a minute: checks, unresolved comments from writers, and the end of the pull request', async () => {
  const s = await setup(); let now = new Date('2026-11-18T12:00:00Z');
  try {
    (s.pulls as unknown as { now: () => Date }).now = () => now;
    s.pulls.save('fixture', { publish: 'ask' });
    const t = await s.finished(); await s.pulls.publish(t.id, 'user');
    const summary = () => s.f.store.summaries({ openPullRequest: true }).tasks.map(x => x.pullRequest);
    assert.deepEqual(s.pulls.view(t.id).github!.status, { code: 'not-read', text: 'opened' });
    assert.deepEqual(summary(), [{ number: 42, state: 'open', status: 'opened', code: 'not-read' }]);
    const thread = (id: string, association: string, resolved = false) => ({ id, isResolved: resolved, path: 'src/form.ts', line: 71, comments: { nodes: [{ author: { login: `user-${id}` }, authorAssociation: association, body: `Comment ${id} fixture-secret-value`, url: `https://github.test/c/${id}` }] } });
    s.state.github = {
      runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://github.test/runs/1' }, { name: 'test', status: 'completed', conclusion: 'failure', html_url: 'javascript:alert(1)', output: { title: '1 failed, 23 passed' } }, { name: 'deploy', status: 'completed', conclusion: 'skipped' }],
      statuses: [{ context: 'lint', state: 'pending', description: 'Queued' }, { context: 'build', state: 'failure' }],
      threads: [thread('a', 'MEMBER'), thread('b', 'NONE'), thread('c', 'OWNER', true)],
    };
    await s.pulls.syncDue();
    const read = s.pulls.view(t.id).github!;
    assert.deepEqual(read.checks, [{ name: 'build', status: 'passed', url: 'https://github.test/runs/1' }, { name: 'test', status: 'failed', summary: '1 failed, 23 passed' }, { name: 'deploy', status: 'skipped' }, { name: 'lint', status: 'running', summary: 'Queued' }]);
    assert.deepEqual(read.comments.map(c => [c.id, c.author, c.counts, c.path, c.line]), [['a', 'user-a', true, 'src/form.ts', 71], ['b', 'user-b', false, 'src/form.ts', 71]]);
    assert.doesNotMatch(JSON.stringify(read), /fixture-secret-value/, 'remote text is redacted before it is stored');
    assert.deepEqual(read.status, { code: 'checks-failed', text: '1 check failed' }); assert.equal(read.headSha, 'f'.repeat(40)); assert.equal(read.draft, true);
    const calls = s.state.calls.length;
    await s.pulls.syncDue();
    assert.equal(s.state.calls.length, calls, 'nothing is read again within a minute');

    const step = async (change: NonNullable<Remote['github']>) => { now = new Date(now.getTime() + 61000); s.state.github = { ...s.state.github, ...change }; await s.pulls.syncDue(); return s.pulls.view(t.id).github!; };
    assert.equal((await step({ runs: [{ name: 'test', status: 'in_progress' }], statuses: [] })).status.text, 'checks running');
    assert.equal((await step({ runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] })).status.text, '1 comment open');
    assert.equal((await step({ threads: [thread('b', 'NONE')], mergeable: 'dirty' })).status.text, 'conflict with main');
    assert.equal((await step({ mergeable: 'blocked' })).status.text, 'waiting for GitHub');
    assert.equal((await step({ mergeable: 'clean' })).status.text, 'ready to merge');
    const failed = await step({ down: true });
    assert.match(failed.error!, /did not accept the token/); assert.equal(failed.status.text, 'ready to merge', 'a failed read keeps what the last one found'); assert.equal(failed.checks.length, 1);
    const merged = await step({ down: false, merged: true });
    assert.deepEqual(merged.status, { code: 'merged', text: 'merged into main' }); assert.equal(merged.error, undefined);
    assert.deepEqual(summary(), []);
    assert.deepEqual(s.f.store.summaries({ states: ['completed'] }).tasks.find(x => x.id === t.id)!.pullRequest, { number: 42, state: 'merged', status: 'merged into main', code: 'merged' });
    const after = s.state.calls.length; now = new Date(now.getTime() + 61000);
    await s.pulls.syncDue();
    assert.equal(s.state.calls.length, after, 'a merged pull request is not read any more');
  } finally { await s.f.cleanup(); }
});
