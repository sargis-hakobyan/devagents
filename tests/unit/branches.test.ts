import test from 'node:test';
import assert from 'node:assert/strict';
import { branchSlug, commitSubject, isOwnedBranch, isTaskBranch, itemBranch, ownedRefPatterns, taskBranch } from '../../src/workspace/branches.js';

const id = '12b1ca2d-fce6-4d5a-95f6-7af3c465fe0d';

test('task branches are named after the request and the short task id, without an engine prefix', () => {
  assert.equal(taskBranch(id, '„Meine Aufträge“ zuverlässig nach aktueller Verantwortlichkeit filtern\n\nDetails follow.'), 'devagents/meine-auftraege-zuverlaessig-nach-aktueller-12b1ca2d');
  assert.equal(taskBranch(id, 'Fix the mailbox label!'), 'devagents/fix-the-mailbox-label-12b1ca2d');
  assert.equal(branchSlug('   \n\n  '), 'task');
  assert.equal(branchSlug('Ünïcode → ok'), 'uenicode-ok');
  assert.equal(branchSlug('a'.repeat(80)), 'a'.repeat(48), 'one long word is cut to the limit');
  assert.equal(branchSlug('short words only until the limit is reached by the next one', 20), 'short-words-only');
  assert.ok(!taskBranch(id, 'x').includes('codex/'));
});

test('ownership accepts the task branch, its item branches and legacy names, and nothing else', () => {
  const branch = taskBranch(id, 'Fix orders');
  assert.ok(isTaskBranch(branch, id)); assert.ok(isOwnedBranch(branch, id));
  assert.ok(isOwnedBranch(itemBranch(branch, 'api-filter'), id)); assert.ok(!isTaskBranch(itemBranch(branch, 'api-filter'), id));
  assert.ok(isTaskBranch(`codex/devagents-${id}`, id)); assert.ok(isOwnedBranch(`codex/devagents-${id}-greeting`, id));
  const other = '99999999-fce6-4d5a-95f6-7af3c465fe0d';
  assert.ok(!isOwnedBranch(branch, other)); assert.ok(!isOwnedBranch(`codex/devagents-${id}`, other));
  assert.ok(!isOwnedBranch('main', id)); assert.ok(!isOwnedBranch('devagents/fix-orders-12b1ca2d-', id)); assert.ok(!isOwnedBranch('devagents/fix-orders-12b1ca2d-1bad', id));
  assert.ok(!isOwnedBranch('user/fix-orders-12b1ca2d', id)); assert.ok(!isOwnedBranch(branch, 'not-a-task-id'));
  assert.deepEqual(ownedRefPatterns(id), [`refs/heads/codex/devagents-${id}`, `refs/heads/codex/devagents-${id}-*`, 'refs/heads/devagents/*-12b1ca2d', 'refs/heads/devagents/*-12b1ca2d-*']);
});

test('commit subjects come from the first request line, cut at a word boundary', () => {
  assert.equal(commitSubject('Fix the mailbox label\n\nMore detail'), 'Fix the mailbox label');
  assert.equal(commitSubject(''), 'Implement reviewed DevAgents task');
  const long = commitSubject('Make the order list filter by the current responsibility so that campaigners of the same team no longer see each other');
  assert.ok(long.length <= 72 && long.endsWith('…') && !long.includes('  '), long);
  assert.equal(long, 'Make the order list filter by the current responsibility so that…');
});
