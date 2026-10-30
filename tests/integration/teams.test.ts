import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from '../helpers.js';
import { Store } from '../../src/persistence/store.js';
import { TaskService } from '../../src/orchestration/service.js';
import { Config, type TeamMember, type TeamRecord } from '../../src/domain/schemas.js';
import { member } from '../fixtures/team-members.js';

/** The editable part of a stored team, as a client sends it back. */
const input = (team: TeamRecord, patch: Partial<Pick<TeamRecord, 'name' | 'description' | 'members'>> = {}) => ({ name: team.name, description: team.description, members: team.members, ...patch });

/** Explicit copies of the built-in templates, the way the browser builds a team. */
async function templateTeam(service: TaskService, ids: string[], name = 'Website team'): Promise<{ name: string; description: string; members: TeamMember[] }> {
  const templates = await service.templates();
  return { name, description: 'Copied from templates', members: ids.map(id => { const t = templates.find(x => x.id === id); assert.ok(t, id); return t; }) };
}

test('a schema-2 database upgrades in place and keeps projects, tasks and events', async () => {
  const f = await fixture();
  try {
    const task = f.service.submit({ projectId: 'fixture', request: 'Before upgrade', mode: 'autonomous' }, 'pre-upgrade');
    // Roll the file back to what a schema-2 service left behind (a second connection; the fixture closes its own).
    const raw = new DatabaseSync(join(f.dataDir, 'test.db'));
    raw.exec('DROP TRIGGER team_revisions_no_update; DROP TRIGGER team_revisions_no_delete; DROP TABLE team_revisions; DROP TABLE teams; PRAGMA user_version=2;');
    raw.close();
    const reopened = new Store(join(f.dataDir, 'test.db'));
    try {
      assert.equal(reopened.project('fixture').version, 0); assert.equal(reopened.project('fixture').defaultTeamId, undefined);
      const kept = reopened.task(task.id); assert.equal(kept.request, 'Before upgrade'); assert.equal(kept.team, undefined);
      assert.equal(reopened.events(task.id).length, 1);
      assert.deepEqual(reopened.teams('all'), []);
      const service = new TaskService(reopened, Config.parse({ schemaVersion: 1 }), f.dataDir);
      assert.equal(service.createTeam(await templateTeam(service, ['tech-lead', 'general-developer', 'code-reviewer'])).readiness.ready, true);
      const legacy = service.submit({ projectId: 'fixture', request: 'Still legacy', mode: 'autonomous' }, 'post-upgrade');
      assert.equal(legacy.team, undefined, 'projects without a default keep the legacy registry path');
    } finally { reopened.close(); }
  } finally { await f.cleanup(); }
});

test('teams are created from template copies or custom members, revised, duplicated and archived without affecting each other', async () => {
  const f = await fixture();
  try {
    const website = f.service.createTeam(await templateTeam(f.service, ['tech-lead', 'general-developer', 'code-reviewer']));
    assert.equal(website.revision, 1); assert.equal(website.readiness.ready, true);
    assert.deepEqual(website.members.map(m => [m.origin, m.templateId]), [['template', 'tech-lead'], ['template', 'general-developer'], ['template', 'code-reviewer']]);
    const designer = member({ id: 'graphic-designer', name: 'Graphic Designer', capabilities: ['asset-design', 'filesystem-write'] });
    const draft = f.service.createTeam({ name: 'Design team', members: [...website.members.filter(m => m.id !== 'general-developer'), designer] });
    assert.equal(draft.readiness.ready, false, 'an unsupported capability saves as a draft');
    assert.ok(draft.readiness.diagnostics.some(d => d.code === 'capability_unavailable' && d.memberId === 'graphic-designer'));
    assert.ok(draft.readiness.diagnostics.every(d => d.level === 'warning' || d.memberId === 'graphic-designer'), 'the designer can write, so the only error is its capability');
    assert.deepEqual(f.service.teams().map(t => [t.name, t.members, t.readiness.ready]), [['Design team', 3, false], ['Website team', 3, true]]);
    // Rejected outright: traversal, absolute paths, unsupported glob forms, push.
    assert.throws(() => f.service.createTeam({ name: 'Bad', members: [{ ...designer, permissions: { readPaths: ['project:/**'], writePaths: ['project:/../../etc/**'] } }] }), /traversal/i);
    assert.throws(() => f.service.createTeam({ name: 'Bad', members: [{ ...designer, permissions: { readPaths: ['project:/**'], writePaths: ['project:/src/*.js'] } }] }), /subtree|exact/i);
    assert.throws(() => f.service.createTeam({ name: 'Bad', members: [{ ...designer, permissions: { readPaths: ['project:/**'], writePaths: [], allowPush: true } }] }));
    assert.deepEqual(f.service.teams('all').length, 2, 'rejected teams leave nothing behind');
    // Edit creates revision 2; the old revision stays readable and immutable.
    const edited = f.service.updateTeam(website.id, 1, input(website, { name: 'Website team v2', members: website.members.map(m => m.id === 'general-developer' ? { ...m, concurrency: 2 } : m) }));
    assert.equal(edited.revision, 2); assert.equal(edited.name, 'Website team v2');
    assert.equal(f.store.teamRevision(website.id, 1).members.find(m => m.id === 'general-developer')!.concurrency, 1);
    assert.deepEqual(f.store.teamRevisions(website.id).map(r => r.revision), [1, 2]);
    const raw = new DatabaseSync(join(f.dataDir, 'test.db'));
    try { assert.throws(() => raw.prepare('UPDATE team_revisions SET data=? WHERE team_id=? AND revision=1').run('{}', website.id), /immutable/); assert.throws(() => raw.prepare('DELETE FROM team_revisions WHERE team_id=?').run(website.id), /immutable/); } finally { raw.close(); }
    // Duplicate is independent: editing the copy never changes the source.
    const copy = f.service.duplicateTeam(website.id, 'Website copy');
    assert.notEqual(copy.id, website.id); assert.equal(copy.revision, 1); assert.deepEqual(copy.members, edited.members);
    f.service.updateTeam(copy.id, 1, { name: 'Website copy', description: '', members: copy.members.filter(m => m.id !== 'code-reviewer') });
    assert.equal(f.store.team(website.id).members.length, 3);
    // Archive hides from the active list, blocks edits, and restore brings it back as a new revision.
    const archived = f.service.setTeamArchived(copy.id, 2, true);
    assert.equal(archived.archived, true); assert.equal(archived.revision, 3);
    assert.deepEqual(f.service.teams().map(t => t.name), ['Design team', 'Website team v2']); assert.deepEqual(f.service.teams('archived').map(t => t.name), ['Website copy']);
    assert.throws(() => f.service.updateTeam(copy.id, 3, { name: 'Edit archived', members: [] }), /archived/i);
    assert.equal(f.service.setTeamArchived(copy.id, 3, false).archived, false);
    assert.equal(f.service.team(website.id).revisions.length, 2);
  } finally { await f.cleanup(); }
});

test('stale edits, archives and project defaults from a second client conflict without losing either change', async () => {
  const f = await fixture();
  try {
    const team = f.service.createTeam(await templateTeam(f.service, ['tech-lead', 'general-developer', 'code-reviewer']));
    const clientA = f.service.updateTeam(team.id, 1, input(team, { description: 'Client A' }));
    assert.throws(() => f.service.updateTeam(team.id, 1, input(team, { description: 'Client B' })), /revision 2/);
    assert.equal(f.store.team(team.id).description, 'Client A');
    assert.throws(() => f.service.setTeamArchived(team.id, 1, true), /revision 2/);
    assert.equal(f.store.team(team.id).archived, false);
    assert.equal(f.service.setTeamArchived(team.id, clientA.revision, true).archived, true);
    const other = f.service.createTeam(await templateTeam(f.service, ['tech-lead', 'general-developer', 'code-reviewer'], 'Other'));
    const project = f.service.setProjectDefaultTeam('fixture', other.id, 0);
    assert.equal(project.version, 1); assert.equal(project.defaultTeamId, other.id);
    assert.throws(() => f.service.setProjectDefaultTeam('fixture', null, 0), /stale_project|changed/);
    assert.equal(f.store.project('fixture').defaultTeamId, other.id);
    assert.throws(() => f.service.setProjectDefaultTeam('fixture', team.id, 1), /archived/);
    assert.equal(f.service.setProjectDefaultTeam('fixture', null, 1).defaultTeamId, undefined);
    assert.equal(f.store.project('fixture').version, 2);
  } finally { await f.cleanup(); }
});

test('submission freezes the team atomically, respects precedence, and refuses drafts and archived defaults', async () => {
  const f = await fixture();
  try {
    const roster = await templateTeam(f.service, ['tech-lead', 'general-developer', 'code-reviewer']);
    const ready = f.service.createTeam(roster);
    const draft = f.service.createTeam({ name: 'Draft', members: roster.members.filter(m => m.id !== 'code-reviewer') });
    // Legacy: no explicit team, no project default.
    const legacy = f.service.submit({ projectId: 'fixture', request: 'Legacy', mode: 'autonomous' }, 'legacy');
    assert.equal(legacy.team, undefined); assert.equal(legacy.agents, undefined);
    // Explicit team.
    const explicit = f.service.submit({ projectId: 'fixture', request: 'Explicit', mode: 'autonomous', teamId: ready.id }, 'explicit');
    assert.equal(explicit.team!.id, ready.id); assert.equal(explicit.team!.revision, 1); assert.equal(explicit.team!.name, 'Website team');
    assert.deepEqual(explicit.team!.members.map(m => [m.id, m.engine, m.provider, m.model]), [['tech-lead', 'codex', 'openai', 'default'], ['general-developer', 'codex', 'openai', 'default'], ['code-reviewer', 'codex', 'openai', 'default']]);
    assert.equal(explicit.team!.modelPinned, false, 'model: default is not a pinned model');
    assert.deepEqual(explicit.team!.providers, [{ id: 'openai', kind: 'openai', auth: 'login' }]);
    assert.equal(explicit.agents!.length, 3); assert.equal(explicit.agents![0]!.source, `team:${ready.id}@1`);
    assert.equal(f.store.summaries({ limit: 10 }).tasks.find(t => t.id === explicit.id)!.team!.name, 'Website team');
    assert.match(f.store.events(explicit.id)[0]!.reason, /team "Website team" revision 1 frozen/);
    // Draft teams cannot receive work; nothing is created.
    assert.throws(() => f.service.submit({ projectId: 'fixture', request: 'Draft', mode: 'autonomous', teamId: draft.id }, 'draft'), /team_not_ready|draft/);
    assert.equal(f.store.summaries({ limit: 10 }).tasks.length, 2);
    // Project default applies when no team is given, and the explicit team still wins.
    const second = f.service.createTeam({ ...roster, name: 'Second' });
    f.service.setProjectDefaultTeam('fixture', second.id, 0);
    assert.equal(f.service.submit({ projectId: 'fixture', request: 'Default', mode: 'autonomous' }, 'default').team!.id, second.id);
    assert.equal(f.service.submit({ projectId: 'fixture', request: 'Override', mode: 'autonomous', teamId: ready.id }, 'override').team!.id, ready.id);
    // Idempotent retry after the team changed returns the original frozen task; a different input with the same key conflicts.
    f.service.updateTeam(ready.id, 1, { ...roster, name: 'Renamed' });
    const retried = f.service.submit({ projectId: 'fixture', request: 'Explicit', mode: 'autonomous', teamId: ready.id }, 'explicit');
    assert.equal(retried.id, explicit.id); assert.equal(retried.team!.revision, 1); assert.equal(retried.team!.name, 'Website team');
    assert.throws(() => f.service.submit({ projectId: 'fixture', request: 'Explicit', mode: 'autonomous', teamId: second.id }, 'explicit'), /different input/);
    // A new submission sees the new revision.
    assert.equal(f.service.submit({ projectId: 'fixture', request: 'After edit', mode: 'autonomous', teamId: ready.id }, 'after-edit').team!.revision, 2);
    // Archived explicit team and archived default both fail with an actionable message; no silent fallback.
    f.service.setTeamArchived(second.id, 1, true);
    assert.throws(() => f.service.submit({ projectId: 'fixture', request: 'Archived default', mode: 'autonomous' }, 'archived-default'), /default team "Second" of project fixture is archived; choose a team explicitly or change the project default/);
    assert.throws(() => f.service.submit({ projectId: 'fixture', request: 'Archived explicit', mode: 'autonomous', teamId: second.id }, 'archived-explicit'), /archived; restore it or choose another team/);
    assert.equal(f.store.summaries({ limit: 20 }).tasks.filter(t => /Archived/.test(t.request)).length, 0);
    assert.throws(() => f.service.submit({ projectId: 'fixture', request: 'Unknown', mode: 'autonomous', teamId: '00000000-0000-4000-8000-000000000000' }, 'unknown'), /Unknown team/);
    assert.throws(() => f.service.submit({ projectId: 'fixture', request: 'Bad id', mode: 'autonomous', teamId: 'not-a-uuid' }, 'bad'));
  } finally { await f.cleanup(); }
});

test('a configured default model pins the snapshot and a member model overrides it', async () => {
  const f = await fixture();
  const service = new TaskService(f.store, Config.parse({ schemaVersion: 1, defaultModel: 'gpt-5-codex' }), f.dataDir);
  try {
    const roster = await templateTeam(service, ['tech-lead', 'general-developer', 'code-reviewer']);
    const team = service.createTeam({ ...roster, members: roster.members.map(m => m.id === 'code-reviewer' ? { ...m, model: 'o4-mini' } : m) });
    assert.equal(team.readiness.diagnostics.length, 0);
    const task = service.submit({ projectId: 'fixture', request: 'Pinned', mode: 'autonomous', teamId: team.id }, 'pinned');
    assert.equal(task.team!.modelPinned, true); assert.equal(task.team!.defaultModel, 'gpt-5-codex');
    assert.deepEqual(task.team!.members.map(m => m.model), ['gpt-5-codex', 'gpt-5-codex', 'o4-mini']);
  } finally { await f.cleanup(); }
});
