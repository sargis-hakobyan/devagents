import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApi } from '../../src/api/server.js';
import { BrowserSessions } from '../../src/api/session.js';
import { fixture } from '../helpers.js';
import type { Project, TeamMember, TeamRecord, TeamReadiness, TeamSummary } from '../../src/domain/schemas.js';

type TeamResponse = TeamRecord & { readiness: TeamReadiness; revisions?: { revision: number }[] };

test('team and default-team routes enforce revisions, validation and the browser security rules', async () => {
  const f = await fixture(); const sessions = new BrowserSessions();
  const server = createApi(f.service, 't', { sessions });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port; const url = `http://127.0.0.1:${port}`;
  const bearer = { authorization: 'Bearer t', 'content-type': 'application/json' };
  const call = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = bearer) => {
    const res = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, json: await res.json() as unknown };
  };
  try {
    const templates = (await call('/teams/templates')).json as TeamMember[];
    assert.equal(templates.length, 6); assert.ok(templates.every(t => t.origin === 'template' && t.templateId === t.id && typeof t.instructions === 'string'));
    const pick = (ids: string[]) => ids.map(id => templates.find(t => t.id === id)!);
    const created = await call('/teams', 'POST', { name: 'Website team <script>x</script>', members: pick(['tech-lead', 'general-developer', 'code-reviewer']) });
    assert.equal(created.status, 201); const team = created.json as TeamResponse;
    assert.equal(team.readiness.ready, true); assert.equal(team.name, 'Website team <script>x</script>', 'hostile text is stored verbatim and rendered as text by the UI');
    // Readiness check for an unsaved draft, and validation errors for forbidden grants.
    const check = await call('/teams/check', 'POST', { name: 'Draft', members: pick(['tech-lead']) });
    assert.equal(check.status, 200); assert.equal((check.json as { readiness: TeamReadiness }).readiness.ready, false);
    const forbidden = await call('/teams', 'POST', { name: 'Bad', members: [{ ...templates[1], permissions: { readPaths: ['project:/**'], writePaths: ['project:/../x/**'] } }] });
    assert.equal(forbidden.status, 400); assert.match(JSON.stringify(forbidden.json), /traversal/i);
    assert.equal((await call('/teams', 'POST', { name: 'Bad', members: [{ ...templates[1], capabilities: ['implementation'], permissions: { readPaths: ['project:/**'], writePaths: ['project:/a/*.ts'] } }] })).status, 400);
    const unsupported = await call('/teams', 'POST', { name: 'Draft design', members: [...pick(['tech-lead', 'code-reviewer']), { ...templates[1], id: 'designer', capabilities: ['asset-design'] }] });
    assert.equal(unsupported.status, 201); assert.equal((unsupported.json as TeamResponse).readiness.ready, false);
    const list = (await call('/teams')).json as TeamSummary[];
    assert.deepEqual(list.map(t => [t.members, t.readiness.ready]), [[3, false], [3, true]]);
    assert.equal((await call('/teams?filter=bogus')).status, 400);
    // Edit requires the expected revision; a stale client gets 409 and the stored team is unchanged.
    const edited = await call(`/teams/${team.id}`, 'PUT', { expectedRevision: 1, team: { name: 'Website team', description: 'edited', members: team.members } });
    assert.equal(edited.status, 200); assert.equal((edited.json as TeamResponse).revision, 2);
    const stale = await call(`/teams/${team.id}`, 'PUT', { expectedRevision: 1, team: { name: 'Lost update', members: team.members } });
    assert.equal(stale.status, 409); assert.equal((stale.json as { error: string }).error, 'stale_team');
    assert.equal(((await call(`/teams/${team.id}`)).json as TeamResponse).name, 'Website team');
    assert.deepEqual(((await call(`/teams/${team.id}`)).json as TeamResponse).revisions!.map(r => r.revision), [1, 2]);
    assert.equal((await call(`/teams/${team.id}`, 'PUT', { expectedRevision: 2, team: { name: 'x', members: team.members }, extra: 1 })).status, 400);
    // Duplicate, archive with stale revision, archive with the right one, default team with version checks.
    const copy = await call(`/teams/${team.id}/duplicate`, 'POST', { name: 'Copy' });
    assert.equal(copy.status, 201); assert.equal((copy.json as TeamResponse).revision, 1);
    assert.equal((await call(`/teams/${team.id}/archive`, 'POST', { expectedRevision: 1, archived: true })).status, 409);
    const project = await call('/projects/fixture/default-team', 'PUT', { teamId: team.id, expectedVersion: 0 });
    assert.equal(project.status, 200); assert.equal((project.json as Project).defaultTeamId, team.id); assert.equal((project.json as Project).version, 1);
    assert.equal((await call('/projects/fixture/default-team', 'PUT', { teamId: null, expectedVersion: 0 })).status, 409);
    assert.equal((await call('/projects/missing/default-team', 'PUT', { teamId: null, expectedVersion: 0 })).status, 404);
    assert.equal((await call('/projects/fixture/default-team', 'PUT', { teamId: 'not-a-uuid', expectedVersion: 1 })).status, 400);
    // Submission through the API uses the default and reports the frozen team in list and detail.
    const task = await call('/tasks', 'POST', { projectId: 'fixture', request: 'Uses default', mode: 'autonomous' }, { ...bearer, 'idempotency-key': 'default' });
    assert.equal(task.status, 201); assert.equal((task.json as { team: { id: string } }).team.id, team.id);
    assert.equal((((await call('/tasks')).json as { tasks: { team?: { name: string } }[] }).tasks[0]!).team!.name, 'Website team');
    assert.equal((await call(`/teams/${team.id}/archive`, 'POST', { expectedRevision: 2, archived: true })).status, 200);
    const archivedDefault = await call('/tasks', 'POST', { projectId: 'fixture', request: 'Archived default', mode: 'autonomous' }, { ...bearer, 'idempotency-key': 'archived' });
    assert.equal(archivedDefault.status, 409); assert.equal((archivedDefault.json as { error: string }).error, 'team_archived');
    assert.equal(((await call('/projects')).json as Project[])[0]!.defaultTeamId, team.id, 'the archived default stays visible so the user can change it');
    // Browser session: GETs work with the cookie; every new mutation needs the CSRF token and a same-origin request.
    const link = await call('/ui/bootstrap', 'POST', {}); const login = await fetch((link.json as { url: string }).url, { redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const sessionInfo = await (await fetch(`${url}/ui/session`, { headers: { cookie } })).json() as { csrfToken: string };
    assert.equal((await fetch(`${url}/teams`, { headers: { cookie } })).status, 200);
    const mutations: [string, string, unknown][] = [
      ['/teams', 'POST', { name: 'From browser', members: pick(['tech-lead', 'general-developer', 'code-reviewer']) }],
      ['/teams/check', 'POST', { name: 'x', members: [] }],
      [`/teams/${(copy.json as TeamResponse).id}`, 'PUT', { expectedRevision: 1, team: { name: 'y', members: [] } }],
      [`/teams/${(copy.json as TeamResponse).id}/archive`, 'POST', { expectedRevision: 1, archived: true }],
      [`/teams/${(copy.json as TeamResponse).id}/duplicate`, 'POST', { name: 'z' }],
      ['/projects/fixture/default-team', 'PUT', { teamId: null, expectedVersion: 1 }],
    ];
    for (const [path, method, body] of mutations) {
      assert.equal((await call(path, method, body, { cookie, 'content-type': 'application/json' })).status, 403, `${method} ${path} without CSRF`);
      assert.equal((await call(path, method, body, { cookie, 'content-type': 'application/json', 'x-csrf-token': sessionInfo.csrfToken, origin: 'https://attacker.invalid' })).status, 403, `${method} ${path} from a foreign origin`);
      assert.equal((await call(path, method, body, { cookie, 'content-type': 'application/json', 'x-csrf-token': sessionInfo.csrfToken, 'sec-fetch-site': 'cross-site' })).status, 403, `${method} ${path} cross-site`);
    }
    assert.equal(((await call('/teams?filter=all')).json as TeamSummary[]).length, 3, 'no refused mutation changed anything');
    assert.equal(((await call('/projects')).json as Project[])[0]!.version, 1);
    const accepted = await call('/projects/fixture/default-team', 'PUT', { teamId: null, expectedVersion: 1 }, { cookie, 'content-type': 'application/json', 'x-csrf-token': sessionInfo.csrfToken, origin: `http://127.0.0.1:${port}` });
    assert.equal(accepted.status, 200); assert.equal((accepted.json as Project).defaultTeamId, undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
});
