import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, MemberInput, TeamInput } from '../../src/domain/schemas.js';
import { developer, lead, member, reviewer } from '../fixtures/team-members.js';
import { teamReadiness, type RuntimeSupport } from '../../src/domain/readiness.js';
import { validatePlan } from '../../src/domain/plan.js';
import { builtinCapabilities } from '../../src/agents/registry.js';

const support = (config: Record<string, unknown> = {}): RuntimeSupport => ({ config: Config.parse({ schemaVersion: 1, ...config }), capabilities: builtinCapabilities, executableEngines: new Set(['codex']), platform: 'darwin' });


test('a complete roster is ready and readiness never depends on sign-in or model access', () => {
  const r = teamReadiness([lead(), developer(), reviewer()], support());
  assert.equal(r.ready, true);
  // Without a configured default model the roster runs on the runtime default and says so instead of claiming a pinned model.
  assert.deepEqual(r.diagnostics.map(d => d.code), ['model_not_pinned', 'model_not_pinned', 'model_not_pinned']);
  assert.equal(teamReadiness([lead(), developer(), reviewer()], support({ defaultModel: 'gpt-5-codex' })).diagnostics.length, 0);
  assert.equal(teamReadiness([lead(), developer(), { ...reviewer(), model: 'o4-mini' }], support()).diagnostics.filter(d => d.memberId === 'reviewer').length, 0);
});
test('incomplete rosters are drafts with one diagnostic per missing role', () => {
  assert.deepEqual(teamReadiness([], support()).diagnostics.map(d => d.code), ['no_planner', 'no_implementer', 'no_reviewer']);
  // The same member cannot implement and review its own work; a distinct reviewer may hold write grants (F5).
  const solo = teamReadiness([lead(), member({ id: 'solo', capabilities: ['implementation', 'review', 'filesystem-write'] })], support());
  assert.equal(solo.ready, false); assert.ok(solo.diagnostics.some(d => d.code === 'no_independent_reviewer'));
  const writableReviewer = member({ id: 'test-reviewer', capabilities: ['review', 'implementation', 'filesystem-write'], permissions: { readPaths: ['project:/**'], writePaths: ['project:/tests/**'], allowCommands: false, allowPush: false } });
  const distinct = teamReadiness([lead(), developer(), writableReviewer], support());
  assert.equal(distinct.ready, true); assert.ok(!distinct.diagnostics.some(d => d.level === 'error'));
  const asAgents = [lead(), developer(), writableReviewer].map(m => ({ ...m, schemaVersion: 1 as const, instructionsFile: 'x', source: 'test' }));
  assert.ok(validatePlan({ summary: 's', risks: [], items: [{ id: 'one', title: 't', description: 'd', acceptanceCriteria: ['a'], dependsOn: [], requiredCapabilities: ['implementation'], projectId: 'fixture', branch: 'codex/one', validation: [{ executable: 'node', args: ['--test'] }], assignedAgent: 'dev' }] }, 'fixture', asAgents, { platform: 'darwin' }), 'plan validation accepts the same roster readiness accepts');
  assert.throws(() => validatePlan({ summary: 's', risks: [], items: [{ id: 'one', title: 't', description: 'd', acceptanceCriteria: ['a'], dependsOn: [], requiredCapabilities: ['implementation'], projectId: 'fixture', branch: 'codex/one', validation: [{ executable: 'node', args: ['--test'] }] }] }, 'fixture', asAgents.filter(a => a.id !== 'dev'), { platform: 'darwin' }), /independent/, 'the writable reviewer selected as implementer leaves no reviewer, as before');
  const disabled = teamReadiness([lead(), { ...developer(), enabled: false }, reviewer()], support());
  assert.equal(disabled.ready, false); assert.ok(disabled.diagnostics.some(d => d.code === 'no_implementer')); assert.ok(disabled.diagnostics.some(d => d.code === 'member_disabled' && d.memberId === 'dev'));
});
test('unsupported capabilities, engines and providers are per-member errors, not silent acceptance', () => {
  const r = teamReadiness([lead(), member({ id: 'designer', capabilities: ['asset-design'] }), reviewer()], support({ providers: [{ id: 'openai', kind: 'openai', auth: 'login' }, { id: 'local', kind: 'ollama', auth: 'none', baseUrl: 'http://127.0.0.1:11434' }] }));
  assert.equal(r.ready, false);
  assert.ok(r.diagnostics.some(d => d.code === 'capability_unavailable' && d.memberId === 'designer' && /asset-design/.test(d.message)));
  const claude = teamReadiness([lead(), { ...developer(), engine: 'claude-code' }, reviewer()], support());
  assert.ok(claude.diagnostics.some(d => d.code === 'engine_unavailable' && d.memberId === 'dev' && /M4/.test(d.message)));
  const local = teamReadiness([lead(), { ...developer(), provider: 'local' }, reviewer()], support({ providers: [{ id: 'openai', kind: 'openai', auth: 'login' }, { id: 'local', kind: 'ollama', auth: 'none', baseUrl: 'http://127.0.0.1:11434' }] }));
  assert.ok(local.diagnostics.some(d => d.code === 'provider_unavailable' && d.memberId === 'dev'));
  assert.ok(teamReadiness([{ ...developer(), provider: 'missing' }], support()).diagnostics.some(d => d.code === 'provider_unknown'));
  // Linux runtimes cannot grant exact-file writes; the diagnostic names the member instead of failing at execution.
  const linux = teamReadiness([lead(), { ...developer(), permissions: { ...developer().permissions, writePaths: ['project:/src/index.ts'] } }, reviewer()], { ...support(), platform: 'linux' });
  assert.ok(linux.diagnostics.some(d => d.code === 'write_grant_unsupported' && d.memberId === 'dev'));
});
test('malformed and forbidden members cannot be saved at all', () => {
  assert.throws(() => MemberInput.parse({ ...developer(), permissions: { readPaths: ['project:/**'], writePaths: ['project:/../etc/**'] } }), /traversal/i);
  assert.throws(() => MemberInput.parse({ ...developer(), permissions: { readPaths: ['/etc/passwd'], writePaths: [] } }), /regex|Invalid/i);
  assert.throws(() => MemberInput.parse({ ...developer(), permissions: { readPaths: ['project:/**'], writePaths: [], allowPush: true } }));
  assert.throws(() => teamReadiness([member({ id: 'glob', permissions: { readPaths: ['project:/**'], writePaths: ['project:/src/*.ts'], allowCommands: false, allowPush: false } })], support()), /subtree|exact/i);
  assert.throws(() => teamReadiness([member({ id: 'both', delegation: { canReceiveTasks: true, canDelegate: true } })], support()), /nested delegation/i);
  assert.throws(() => teamReadiness([developer(), developer()], support()), /Duplicate member/);
  assert.throws(() => TeamInput.parse({ name: 'Too many', members: Array.from({ length: 13 }, (_, i) => member({ id: `m${i}` })) }));
  assert.throws(() => MemberInput.parse({ ...developer(), instructions: 'x'.repeat(16001) }));
  assert.throws(() => MemberInput.parse({ ...developer(), extra: true }));
});
