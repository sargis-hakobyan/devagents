/**
 * Names of the branches DevAgents owns. A task branch reads `devagents/<slug>-<short id>`: the slug is
 * taken from the first line of the request, the short id is the first eight characters of the task id,
 * which keeps the name unique and lets ownership checks tie a branch back to its task. Work-item branches
 * append `-<item id>`. Branches recorded by earlier versions (`codex/devagents-<task id>`) stay owned so
 * their diffs and cleanup keep working.
 */
export const BRANCH_NAMESPACE = 'devagents/';
const LEGACY_NAMESPACE = 'codex/devagents-';
const SLUG_LIMIT = 48;
const TRANSLITERATIONS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', æ: 'ae', ø: 'oe', å: 'aa' };
const TASK_ID = /^[a-f0-9-]{36}$/;
const ITEM_ID = /^[a-z][a-z0-9-]{0,63}$/;

export function shortId(taskId: string): string { return taskId.slice(0, 8); }
export function firstLine(request: string): string { return request.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? ''; }
/** Lower-case ASCII words joined by hyphens, cut at a word boundary; never empty. */
export function branchSlug(request: string, limit = SLUG_LIMIT): string {
  const words = firstLine(request).toLowerCase().replace(/[äöüßæøå]/g, c => TRANSLITERATIONS[c] ?? c)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  let slug = '';
  for (const word of words) { const next = slug ? `${slug}-${word}` : word; if (next.length > limit) break; slug = next; }
  if (!slug && words[0]) slug = words[0].slice(0, limit);
  return slug || 'task';
}
export function taskBranch(taskId: string, request: string): string { return `${BRANCH_NAMESPACE}${branchSlug(request)}-${shortId(taskId)}`; }
export function itemBranch(taskBranchName: string, itemId: string): string { return `${taskBranchName}-${itemId}`; }
/** A commit subject from the request: its first line, cut at a word boundary. */
export function commitSubject(request: string, limit = 72): string {
  const line = firstLine(request).replace(/\s+/g, ' ');
  if (line.length <= limit) return line || 'Implement reviewed DevAgents task';
  const cut = line.slice(0, limit - 1); const space = cut.lastIndexOf(' ');
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, '')}…`;
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const taskPattern = (taskId: string) => `${escape(BRANCH_NAMESPACE)}[a-z0-9]+(?:-[a-z0-9]+)*-${shortId(taskId)}`;
/** True when `branch` is the task branch of `taskId` (current or legacy form). */
export function isTaskBranch(branch: string, taskId: string): boolean {
  if (!TASK_ID.test(taskId)) return false;
  return branch === `${LEGACY_NAMESPACE}${taskId}` || new RegExp(`^${taskPattern(taskId)}$`).test(branch);
}
/** True for the task branch or one of its work-item branches. */
export function isOwnedBranch(branch: string, taskId: string): boolean {
  if (isTaskBranch(branch, taskId)) return true;
  if (!TASK_ID.test(taskId)) return false;
  const legacy = `${LEGACY_NAMESPACE}${taskId}-`;
  if (branch.startsWith(legacy)) return ITEM_ID.test(branch.slice(legacy.length));
  const match = new RegExp(`^${taskPattern(taskId)}-(.+)$`).exec(branch);
  return match !== null && ITEM_ID.test(match[1]!);
}
/** `git for-each-ref` patterns that can list a task's branches; filter the result with isOwnedBranch. */
export function ownedRefPatterns(taskId: string): string[] {
  return [`refs/heads/${LEGACY_NAMESPACE}${taskId}`, `refs/heads/${LEGACY_NAMESPACE}${taskId}-*`, `refs/heads/${BRANCH_NAMESPACE}*-${shortId(taskId)}`, `refs/heads/${BRANCH_NAMESPACE}*-${shortId(taskId)}-*`];
}
