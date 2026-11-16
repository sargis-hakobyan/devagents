import test from 'node:test';
import assert from 'node:assert/strict';
import { repositoryFromRemote, tokenExpiry, tokenKind } from '../../src/integrations/github.js';
import { normalizeSite, ruleJql } from '../../src/integrations/jira.js';
import { GitHubConnectInput, JiraConnectInput, JiraRuleInput, connectionState } from '../../src/domain/integrations.js';
import { redactValues } from '../../src/telemetry/redact.js';
import { AppError } from '../../src/domain/errors.js';

test('a GitHub repository is read from common remote forms and never keeps embedded credentials', () => {
  for (const url of ['https://github.com/example-org/website.git', 'https://github.com/example-org/website', 'https://github.com/example-org/website/', 'git@github.com:example-org/website.git', 'ssh://git@github.com/example-org/website.git', 'https://someone:not-a-real-secret@github.com/example-org/website.git']) {
    assert.equal(repositoryFromRemote(url), 'example-org/website', url);
  }
  assert.equal(repositoryFromRemote('https://github.com/example-org/web.site.git'), 'example-org/web.site');
  for (const url of ['https://gitlab.com/example-org/website.git', 'https://github.com.attacker.invalid/a/b', 'https://github.com/only-owner', '/local/path', 'https://github.com/a/b/c', '']) assert.equal(repositoryFromRemote(url), undefined, url);
});

test('GitHub token kinds and end dates are recognized', () => {
  assert.equal(tokenKind(`github_pat_${'A1b2'.repeat(8)}`), 'fine-grained');
  assert.equal(tokenKind(`ghp_${'A1b2'.repeat(9)}`), 'classic');
  for (const token of ['gh_short', 'ghp_short', 'not-a-github-token', `ATATT${'x'.repeat(30)}`]) assert.equal(tokenKind(token), undefined, token);
  assert.equal(tokenExpiry('2026-12-31 08:00:00 UTC'), '2026-12-31T08:00:00.000Z');
  assert.equal(tokenExpiry('2026-12-31 10:00:00 +0200'), '2026-12-31T08:00:00.000Z');
  assert.equal(tokenExpiry(null), undefined); assert.equal(tokenExpiry('soon'), undefined);
});

test('a Jira address becomes one https base and unsafe forms are refused', () => {
  assert.equal(normalizeSite('example.atlassian.net'), 'https://example.atlassian.net');
  assert.equal(normalizeSite(' https://example.atlassian.net/ '), 'https://example.atlassian.net');
  assert.equal(normalizeSite('https://jira.example.com/jira/'), 'https://jira.example.com/jira');
  for (const site of ['http://jira.example.com', 'https://user:pass@jira.example.com', 'https://jira.example.com/?x=1', 'https://localhost', 'not a host']) {
    assert.throws(() => normalizeSite(site), (error: unknown) => error instanceof AppError && error.code === 'invalid_site', site);
  }
});

test('a pick-up rule becomes bounded JQL with quoted values', () => {
  const project = { key: 'WEB', name: 'Website' };
  assert.equal(ruleJql({ project, column: { name: 'Ready for agents', statusIds: ['10001', '10002'] } }), 'project = "WEB" AND status in (10001, 10002) ORDER BY created ASC');
  assert.equal(ruleJql({ project, assignee: { id: '5b10a2844c20165700ede21g', name: 'Agents' }, label: 'devagents' }), 'project = "WEB" AND statusCategory != Done AND assignee = "5b10a2844c20165700ede21g" AND labels = "devagents" ORDER BY created ASC');
  assert.equal(ruleJql({ project, assignee: { id: 'o"brien\\x', name: 'Odd' } }), 'project = "WEB" AND statusCategory != Done AND assignee = "o\\"brien\\\\x" ORDER BY created ASC');
});

test('connection input is strict and a rule cannot mean every ticket', () => {
  assert.equal(GitHubConnectInput.safeParse({ token: 'has whitespace inside' }).success, false);
  assert.equal(GitHubConnectInput.safeParse({ repository: 'https://github.com/a/b' }).success, false);
  assert.equal(GitHubConnectInput.safeParse({ repository: 'example-org/website', extra: true }).success, false);
  assert.equal(JiraConnectInput.safeParse({ kind: 'cloud', site: 'example.atlassian.net' }).success, false, 'Jira Cloud needs an email');
  assert.equal(JiraConnectInput.safeParse({ kind: 'data-center', site: 'jira.example.com', email: 'someone@example.com' }).success, false);
  assert.equal(JiraConnectInput.safeParse({ kind: 'cloud', site: 'example.atlassian.net', email: 'someone@example.com', expiresOn: '2027-02-30x' }).success, false);
  assert.equal(JiraConnectInput.safeParse({ kind: 'cloud', site: 'example.atlassian.net', email: 'someone@example.com', expiresOn: '2027-11-12' }).success, true);
  assert.equal(JiraRuleInput.safeParse({ project: 'WEB' }).success, false);
  assert.equal(JiraRuleInput.safeParse({ project: 'WEB', label: 'two words' }).success, false);
  assert.deepEqual(JiraRuleInput.parse({ project: 'WEB', label: 'devagents' }), { project: 'WEB', label: 'devagents', start: 'manual' });
});

test('a connection reports the most important thing about it', () => {
  const now = new Date('2026-11-13T12:00:00Z');
  assert.deepEqual(connectionState({}, now, false), { state: 'connected' });
  assert.deepEqual(connectionState({ expiresAt: '2027-01-10T12:00:00Z' }, now, false), { state: 'connected', expiresInDays: 58 });
  assert.deepEqual(connectionState({ expiresOn: '2026-11-20' }, now, false), { state: 'expiring', expiresInDays: 7 });
  assert.deepEqual(connectionState({ expiresOn: '2026-11-01' }, now, false).state, 'expired');
  const problem = { code: 'token_rejected' as const, message: 'No', at: now.toISOString() };
  assert.equal(connectionState({ problem, expiresOn: '2027-11-01' }, now, false).state, 'rejected');
  assert.equal(connectionState({ problem: { ...problem, code: 'not_reachable' } }, now, false).state, 'unreachable');
  assert.equal(connectionState({ problem }, now, true).state, 'locked');
});

test('Atlassian API tokens are redacted by shape like GitHub tokens', () => {
  const atlassian = `ATATT3xFfGF0${'aB3_-'.repeat(8)}=1A2B3C4D`;
  assert.equal(redactValues(`token ${atlassian} and ghp_${'a'.repeat(36)} end`), 'token [REDACTED] and [REDACTED] end');
  assert.equal(redactValues('ATATTENTION is a word'), 'ATATTENTION is a word');
});
