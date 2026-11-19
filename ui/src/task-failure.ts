import { evidenceFacts, type Evidence, type Task } from './api.js';

export type TaskFailure = { title: string; reason: string; nextStep: string; report?: string; technical: string };

/** Keep historical errors readable without rewriting task history or treating agent reports as approval. */
export function taskFailure(task: Pick<Task, 'outcome'>, evidence: Evidence[]): TaskFailure {
  const technical = task.outcome?.error ?? '';
  const item = /^Work item (\S+) produced no changes/.exec(technical)?.[1];
  const combined = technical.startsWith('Combined task has no changes');
  const implementation = technical.startsWith('Implementation produced no reviewable changes');
  if (implementation || item || combined) {
    const reports = evidence.filter(e => {
      const d = evidenceFacts(e);
      return e.kind === 'run-completed' && d.phase === 'implementation' && (item ? d.workItemId === item : !d.workItemId);
    });
    const output = (implementation || item) && reports.length ? evidenceFacts(reports.at(-1)!).output as { summary?: unknown } | undefined : undefined;
    const report = typeof output?.summary === 'string' ? output.summary.trim().split(/\n\s*\n/)[0]!.slice(0, 1200) : '';
    return {
      title: 'Stopped because no code changes were produced',
      reason: combined
        ? 'The combined work contains no changes from the starting code. DevAgents requires a code change to complete a task, so it stopped before combined validation and independent review. No final task commit was created.'
        : `${item ? `Work item “${item}”` : 'The developer'} finished without changing any reviewable files. DevAgents requires a code change to complete ${item ? 'each work item' : 'a task'}, so ${item ? 'this item' : 'this task'} stopped before automated validation and independent review of that result. The task did not produce a final commit.`,
      nextStep: 'Check whether the requested behavior already exists in the starting code. If it does, verify it before closing the ticket. If something is still missing, describe the remaining problem in a new task. Repeating the same request may stop here again.',
      ...(report ? { report } : {}), technical,
    };
  }
  if (technical.startsWith('QA could not verify required acceptance criteria.')) return {
    title: 'Stopped because QA could not verify required behavior', reason: technical,
    nextStep: 'Check the QA evidence in Activity for the missing prerequisite. Make the required checks available before submitting a new task.', technical,
  };
  if (/Service shutdown interrupted/.test(technical)) return {
    title: 'Interrupted by a service shutdown', reason: technical,
    nextStep: 'Inspect Activity and any recovery snapshot in Result before submitting a new task. Interrupted work is not restarted automatically.', technical,
  };
  if (technical.startsWith('Repair budget exhausted')) return {
    title: 'Stopped after the allowed repair attempts', reason: technical,
    nextStep: 'Review the remaining test failures or review findings in Activity. Address those blockers before submitting a new task.', technical,
  };
  return {
    title: 'The task stopped with an error', reason: technical || 'No failure reason was saved for this task.',
    nextStep: 'Open Activity to inspect the last failed step and its evidence. Resolve the reported problem before submitting a new task.', technical,
  };
}
