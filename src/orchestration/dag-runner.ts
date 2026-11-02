import { validationEvidence } from './validation-evidence.js';
import { describeLimitations, implementationLimitationInstructions, LimitationLedger, reviewLimitationInstructions } from '../domain/limitations.js';
import { taskRules } from '../domain/execution-policy.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { CodingEngine, EnginePhase, Validator, ValidationResult } from '../domain/engine.js';
import type { AgentDefinition, AppConfig, Task, WorkItem } from '../domain/schemas.js';
import { AppError } from '../domain/errors.js';
import { PolicyEngine } from '../domain/policy.js';
import { scopeAgent } from '../domain/ownership.js';
import type { TaskService } from './service.js';
import { ImplementationOutput, ReviewOutput } from './outputs.js';
import type { TaskWorkflows } from './workflows.js';
import { readyWave, AgentSlots } from './dag-scheduler.js';
import { WorkspaceManager, git } from '../workspace/git.js';
import { changes, commitOwned, commitChanges } from '../workspace/changes.js';
import { integrationSnapshot, integrateItem, assertIntegrationConfig } from '../workspace/integration.js';
import { hiddenFiles, assertHiddenUnchanged } from '../workspace/hidden.js';
import { conflictBaselines, unresolvedMarkers } from '../workspace/conflicts.js';
import { assertValidationCommands, validationFailed, describeValidationFailure } from '../domain/validation.js';
import { validateWithSetup } from './validate.js';
import { selectImplementer, independentReviewer } from '../domain/roles.js';

type Workspace = NonNullable<Task['workspace']>;
type Item = z.infer<typeof WorkItem>;
type Context = { cwd: string; workItemId: string };
type Hooks = {
  ledger: LimitationLedger;
  service: TaskService; engine: CodingEngine; validator: Validator; task: Task; agents: AgentDefinition[]; signal: AbortSignal;
  active(): Task;
  move(state: Task['state'], reason: string, patch?: Partial<Pick<Task, 'outcome'>>): Task;
  provider(agent: AgentDefinition): AppConfig['providers'][number];
  invoke(phase: EnginePhase, agent: AgentDefinition, prompt: string, schema: z.ZodType, signal: AbortSignal, context: Context): Promise<unknown>;
  workflows: TaskWorkflows;
  prepareEnvironment(cwd: string, commands: Item['validation'], signal: AbortSignal, workItemId: string, feedback?: string): Promise<void>;
  onRepair(): number;
  stopping(): boolean;
};

export async function runDag(h: Hooks): Promise<void> {
  const { service, task, agents, signal } = h;
  const rules = taskRules(task);
  const plan = task.plan!; const workspace = task.workspace!; const project = service.store.project(task.projectId);
  const originalStatus = await git(project.path, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!plan.integration) throw new AppError('invalid_plan', 'Multi-item execution requires integration instructions');
  const record = (kind: string, data: unknown) => service.store.record(task.id, kind, data);
  const state = (itemId: string, state: string, data: Record<string, unknown> = {}) => record('work-item', { itemId, state, ...data });
  const developers = new Map(plan.items.map(item => {
    const agent = item.assignedAgent ? selectImplementer(agents, item) : undefined;
    if (!agent || !item.ownedPaths) throw new AppError('missing_agent', `No scoped developer for ${item.id}`);
    if (item.branch !== `${workspace.branch}-${item.id}`) throw new AppError('branch_mismatch', `Work item ${item.id} must use branch ${workspace.branch}-${item.id}`);
    assertValidationCommands(item.validation, `Work item ${item.id}`, rules);
    return [item.id, rules ? scopeAgent(agent, item.ownedPaths) : agent];
  }));
  const integrationAgent = agents.find(a => a.id === plan.integration!.assignedAgent && a.enabled && a.delegation.canReceiveTasks);
  if (!integrationAgent || !integrationAgent.permissions.writePaths.length) throw new AppError('missing_agent', 'Writable integration agent is unavailable');
  const integrator = rules ? scopeAgent(integrationAgent, [...new Set(plan.items.flatMap(item => item.ownedPaths!))]) : integrationAgent;
  assertValidationCommands(plan.integration.validation, 'Integration', rules);
  const implementers = new Set([...developers.values()].map(a => a.id)); implementers.add(integrator.id);
  const reviewer = independentReviewer(agents, implementers);
  if (!reviewer) throw new AppError('missing_agent', 'Multi-item execution needs a reviewer independent of every implementer and integrator');
  const readOnlyReviewer = { ...reviewer, permissions: { ...reviewer.permissions, writePaths: [], allowCommands: !rules } };
  for (const agent of [...new Map([...developers.values(), integrator, reviewer].map(a => [a.id, a])).values()]) await h.engine.preflight(h.provider(agent));
  await assertIntegrationConfig(workspace.path);
  h.active(); h.move('running', 'Scheduling approved work items in isolated worktrees');
  for (const item of plan.items) state(item.id, 'pending', { agentId: item.assignedAgent, dependsOn: item.dependsOn, branch: item.branch, ownedPaths: item.ownedPaths });
  const slots = new AgentSlots(); let repairCycles = 0;
  const repair = () => { repairCycles++; h.onRepair(); };
  const invoke = (phase: EnginePhase, agent: AgentDefinition, prompt: string, schema: z.ZodType, workerSignal: AbortSignal, context: Context) =>
    slots.run(agent.id, agent.concurrency, workerSignal, () => h.invoke(phase, agent, prompt, schema, workerSignal, context));
  const prepare = (cwd: string, commands: Item['validation'], workerSignal: AbortSignal, itemId: string, feedback?: string) => {
    const agent = itemId === '@integration' ? integrator : developers.get(itemId)!;
    return slots.run(agent.id, agent.concurrency, workerSignal, () => h.prepareEnvironment(cwd, commands, workerSignal, itemId, feedback));
  };
  /** With extra rules enabled, hidden (ignored) files must stay untouched. */
  // Checks that could not run in this environment, reported by any worker or reviewer at any gate; kept with the result, never retried.
  const ledger = h.ledger;
  const implement = async (agent: AgentDefinition, prompt: string, workerSignal: AbortSignal, context: Context) => {
    await prepare(context.cwd, context.workItemId === '@integration' ? plan.integration!.validation : plan.items.find(i => i.id === context.workItemId)!.validation, workerSignal, context.workItemId);
    const before = rules ? await hiddenFiles(context.cwd) : undefined;
    const output = await invoke('implementation', agent, `${prompt}\n${implementationLimitationInstructions}`, ImplementationOutput, workerSignal, context) as z.infer<typeof ImplementationOutput>;
    h.active(); if (before) assertHiddenUnchanged(before, await hiddenFiles(context.cwd), context.workItemId === '@integration' ? 'Integration repair' : `Work item ${context.workItemId}`);
    return output;
  };
  const validate = async (currentWorkspace: Workspace, commands: Item['validation'], workerSignal: AbortSignal, itemId: string): Promise<ValidationResult[]> => {
    const cwd = currentWorkspace.path;
    const agent = itemId === '@integration' ? integrator : developers.get(itemId)!;
    await prepare(cwd, commands, workerSignal, itemId);
    return validateWithSetup({ commands, rules,
      digest: async () => (await changes(currentWorkspace, agent)).digest,
      execute: command => {
        h.active(); if (workerSignal.aborted) throw new AppError('cancelled', 'Work item cancelled');
        return h.validator.execute(cwd, command, workerSignal, service.config.validationTimeoutMs, rules);
      },
      record: result => { record('validation', { workItemId: itemId, ...result }); },
      recover: feedback => prepare(cwd, commands, workerSignal, itemId, feedback),
    });
  };
  const review = async (current: Awaited<ReturnType<typeof changes>>, evidence: ValidationResult[], cwd: string, itemId: string, criteria: unknown, workerSignal: AbortSignal) => {
    for (const file of current.files) await new PolicyEngine().file(reviewer, cwd, file, 'read');
    const combined = itemId === '@integration';
    const sourceStatus = await git(project.path, ['status', '--porcelain=v1', '--untracked-files=all']);
    const workspaceEvidence = {
      isolatedWorktree: cwd !== project.path,
      originalHeadUnchanged: await git(project.path, ['rev-parse', 'HEAD']) === workspace.baseSha,
      originalGitStatusUnchanged: sourceStatus === originalStatus,
      originalGitStatusCleanBeforeAndNow: originalStatus === '' && sourceStatus === '',
    };
    record('review-context', { workItemId: itemId, stage: combined ? 'combined' : 'item', workspaceEvidence });
    const stage = combined
      ? 'FINAL COMBINED GATE: assess the complete request, all user acceptance criteria, the full diff and combined validation. Approval permits the final task commit. Missing combined validation or any actionable defect must block approval.'
      : 'ITEM INTEGRATION GATE: assess only this item\'s deliverable, owned changes and declared item validation. Approval permits integration of this item, not task completion. Task-wide tests and acceptance checks run at the mandatory final combined gate after all items are integrated. Do not demand combined validation at this item gate or ask the implementer to access the original checkout. Report defects in this item; defer checks explicitly reserved for the combined gate.';
    const assessment = await invoke('review', readOnlyReviewer,
      `Independently review this ${combined ? 'combined change' : 'work item'} against its acceptance criteria. ${stage} Do not modify files.${rules ? ' Do not execute commands.' : ' Read-only inspection commands are available.'} Findings must contain only actionable defects requiring repair. Positive observations belong in summary. Approve only with approved=true and findings=[]. ${reviewLimitationInstructions}\nRecorded limitations so far: ${JSON.stringify(ledger.snapshot())}\nOrchestrator workspace evidence: ${JSON.stringify(workspaceEvidence)}. Git-status comparisons do not attest ignored files or the contents of already-dirty/untracked files.\nUser request: ${task.request}\nUser acceptance criteria (task-wide context): ${JSON.stringify(task.acceptanceCriteria)}\nScope and acceptance criteria: ${JSON.stringify(criteria)}\nDiff:\n${current.diff}\nActual validation:\n${validationEvidence(evidence)}`,
      ReviewOutput, workerSignal, { cwd, workItemId: itemId }) as z.infer<typeof ReviewOutput>;
    return assessment;
  };
  const executeItem = async (item: Item, baseSha: string, workerSignal: AbortSignal) => {
    const developer = developers.get(item.id)!; let localRepairs = 0; let worker: Workspace | undefined;
    const check = () => { h.active(); if (workerSignal.aborted) throw new AppError('cancelled', 'Work item cancelled'); };
    try {
      check(); state(item.id, 'creating', { baseSha });
      record('worktree-intent', { owner: task.id, workItemId: item.id, branch: item.branch, baseSha });
      const ownedWorker = await new WorkspaceManager(service.dataDir).createItem(project, task.id, item.id, baseSha);
      worker = ownedWorker;
      state(item.id, 'running', { workspace: worker });
      let feedback = '';
      let completed!: { item: Item; workspace: Workspace; commit: string };
      await h.workflows.repeat(task.id, `item:${item.id}`, async () => {
        check();
        await implement(developer, `Implement only this work item. Dependency results are already present in this worktree. Do not commit or modify Git metadata.${rules ? ' Do not modify ignored files.' : ' Generated files and setup scripts are permitted. Prepare any new dependencies or generated prerequisites before returning; keep source changes visible to review.'}\nRequest: ${task.request}\nUser acceptance criteria: ${JSON.stringify(task.acceptanceCriteria)}\nWork item: ${JSON.stringify(item)}\n${feedback}`, workerSignal, { cwd: ownedWorker.path, workItemId: item.id });
        const before = await changes(ownedWorker, developer);
        if (!before.files.length) throw new AppError('no_changes', `Work item ${item.id} produced no changes`);
        check(); state(item.id, 'validating');
        const evidence = await validate(ownedWorker, item.validation, workerSignal, item.id);
        const after = await changes(ownedWorker, developer);
        if (validationFailed(evidence)) feedback = `${describeValidationFailure(evidence)}. Repair failed validation:\n${validationEvidence(evidence)}`;
        else {
          check(); state(item.id, 'reviewing');
          const assessment = await review(after, evidence, ownedWorker.path, item.id, item, workerSignal);
          if (assessment.approved && !assessment.findings.length) {
            check(); const checked = await changes(ownedWorker, developer);
            if (checked.digest !== after.digest) throw new AppError('review_mutated_files', 'Files changed during work item review');
            state(item.id, 'checkpointing', { files: checked.files });
            record('item-commit-intent', { workItemId: item.id, workspace: worker, digest: checked.digest });
            const commit = await commitOwned(ownedWorker, checked.files, `DevAgents work item ${item.id} (combined review pending)`);
            record('item-commit-created', { workItemId: item.id, commit });
            check(); state(item.id, 'reviewed', { commit, repairCycles: localRepairs });
            completed = { item, workspace: ownedWorker, commit };
            return true;
          }
          feedback = `Repair independent review findings:\n${JSON.stringify(assessment.findings)}`;
        }
        check();
        if (localRepairs >= service.config.maxRepairCycles) throw new AppError('repair_limit', `Work item ${item.id} exhausted its repair budget. ${feedback.slice(0, 2000)}`);
        localRepairs++; repair(); state(item.id, 'repairing', { repairCycles: localRepairs });
        return false;
      });
      return completed;
    } catch (error) {
      // Distinguish why a worker stopped: its own failure, a user cancellation, a service shutdown,
      // or a sibling's failure draining the wave.
      const cause = !workerSignal.aborted ? 'failed' : h.stopping() ? 'interrupted' : signal.aborted ? 'cancelled' : 'aborted';
      state(item.id, cause, { error: error instanceof Error ? error.message : String(error), repairCycles: localRepairs, ...(cause === 'aborted' ? { reason: 'A sibling work item failed; this worker was drained' } : cause === 'interrupted' ? { reason: 'Service shutdown interrupted this worker' } : {}) });
      throw error;
    }
  };
  const done = new Set<string>(); const started = new Set<string>(); let integrationRepairs = 0;
  try {
    await h.workflows.repeat(task.id, 'dependency-waves', async () => {
      h.active();
      const nodes = readyWave(plan.items.map(item => ({ ...item, agentId: developers.get(item.id)!.id, agentConcurrency: developers.get(item.id)!.concurrency })), done, service.config.concurrency);
      const baseSha = await integrationSnapshot(workspace, integrator);
      record('dependency-checkpoint', { baseSha, completed: [...done] });
      const abort = new AbortController(); const cancel = () => abort.abort(); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) abort.abort();
      let failure: unknown;
      const results = await h.workflows.parallel(task.id, nodes.length, async index => {
        const node = nodes[index]!;
        started.add(node.id);
        return executeItem(plan.items.find(i => i.id === node.id)!, baseSha, abort.signal).catch(error => {
          failure ??= error; abort.abort(); throw failure;
        });
      }).finally(() => signal.removeEventListener('abort', cancel));
      h.active();
      for (const completed of results) {
        state(completed.item.id, 'integrating');
        record('integration-intent', { workItemId: completed.item.id, commit: completed.commit });
        const conflicts = await integrateItem(workspace, completed.workspace, completed.commit, integrator);
        if (conflicts.length) {
          record('integration-conflict', { workItemId: completed.item.id, files: conflicts, agentId: integrator.id });
          // Read both sides from the unmerged index now: staging the repair later discards them, and a
          // bare "=======" is only a leftover divider when neither side had that many underlines.
          const baselines = await conflictBaselines(workspace.path, conflicts);
          let resolved = false;
          await h.workflows.repeat(task.id, `conflict:${completed.item.id}`, async () => {
            h.active();
            if (integrationRepairs >= service.config.maxRepairCycles) throw new AppError('integration_conflict', 'Integration conflict exhausted the repair budget; inspect preserved worktrees and evidence.');
            integrationRepairs++; repair();
            for (const file of conflicts) await new PolicyEngine().file(integrator, workspace.path, file, 'write');
            await implement(integrator, `Resolve this explicit integration conflict. Preserve all work-item requirements. Edit project files only; do not use Git or commit.${rules ? ' Do not touch ignored files.' : ''} Remove conflict markers.\nUser request: ${task.request}\nPlan: ${JSON.stringify(plan)}\nConflicting files: ${JSON.stringify(conflicts)}`, signal, { cwd: workspace.path, workItemId: '@integration' });
            await changes(workspace, integrator);
            resolved = true;
            for (const file of conflicts) {
              const path = await new PolicyEngine().file(integrator, workspace.path, file, 'write');
              const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
              const problem = unresolvedMarkers(text, baselines.get(file) ?? 0);
              if (problem) { resolved = false; record('integration-unresolved', { workItemId: completed.item.id, file, problem, repairCycles: integrationRepairs }); }
            }
            if (resolved) {
              await assertIntegrationConfig(workspace.path);
              await git(workspace.path, ['add', '--', ...conflicts]);
              // Content was checked above; staging alone proves nothing, so also confirm Git sees no unmerged entry.
              const unmerged = (await git(workspace.path, ['diff', '--name-only', '--diff-filter=U', '-z'], false)).split('\0').filter(Boolean);
              if (unmerged.length) throw new AppError('integration_conflict', `Unmerged entries remain after repair: ${unmerged.join(', ')}`);
              record('integration-resolved', { workItemId: completed.item.id, files: conflicts, repairCycles: integrationRepairs });
            }
            return resolved;
          });
        }
        await changes(workspace, integrator);
        done.add(completed.item.id); state(completed.item.id, 'completed', { commit: completed.commit });
      }
      return done.size === plan.items.length;
    });
    const commands = [...new Map([...plan.items.flatMap(i => i.validation), ...plan.integration.validation].map(c => [JSON.stringify(c), c])).values()];
    await h.workflows.repeat(task.id, 'combined-validation-review', async () => {
      h.active(); h.move('validating', 'Validating combined work-item results');
      const before = await changes(workspace, integrator);
      if (!before.files.length) throw new AppError('no_changes', 'Combined task has no changes');
      const evidence = await validate(workspace, commands, signal, '@integration');
      const after = await changes(workspace, integrator);
      let feedback = '';
      if (validationFailed(evidence)) feedback = `${describeValidationFailure(evidence)}. Combined validation failed:\n${validationEvidence(evidence)}`;
      else {
        h.active(); h.move('reviewing', 'Independent combined review');
        const assessment = await review(after, evidence, workspace.path, '@integration', plan, signal);
        if (assessment.approved && !assessment.findings.length) {
          h.active(); const checked = await changes(workspace, integrator);
          if (checked.digest !== after.digest) throw new AppError('review_mutated_files', 'Files changed during combined review');
          h.active(); h.move('committing', 'Finalizing reviewed combined local commit');
          record('commit-intent', { branch: workspace.branch, digest: checked.digest, files: checked.files });
          const commit = await commitChanges(project, workspace, checked.files);
          record('commit-created', { commit, branch: workspace.branch });
          const reported = ledger.snapshot();
          h.move('completed', `DAG execution, combined validation and review passed; local commit created${describeLimitations(reported)}`, { outcome: { commit, files: checked.files, summary: plan.summary, repairCycles, ...reported } });
          return true;
        }
        feedback = `Combined review requested repairs:\n${JSON.stringify(assessment.findings)}`;
      }
      h.active();
      if (integrationRepairs >= service.config.maxRepairCycles) throw new AppError('repair_limit', `Combined integration repair budget exhausted. ${feedback.slice(0, 2000)}`);
      integrationRepairs++; repair(); h.move('repairing', 'Bounded integration repair requested', { outcome: { repairCycles } });
      h.move('running', 'Integration agent repairing combined result');
      await implement(integrator, `Repair the combined result within the plan's owned paths. Do not commit or modify Git metadata.${rules ? ' Do not modify ignored files.' : ' Generated files and setup scripts are permitted. Prepare any new dependencies or generated prerequisites before returning; keep source changes visible to review.'}\nRequest: ${task.request}\nPlan: ${JSON.stringify(plan)}\n${feedback}`, signal, { cwd: workspace.path, workItemId: '@integration' });
      return false;
    });
  } catch (error) {
    for (const item of plan.items) if (!done.has(item.id) && !started.has(item.id)) state(item.id, signal.aborted && !h.stopping() ? 'cancelled' : 'blocked', { reason: h.stopping() ? 'Service shutdown stopped the task before this item started' : 'Task stopped before dependencies completed' });
    throw error;
  }
}
