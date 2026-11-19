import { validationEvidence } from './validation-evidence.js';
import { describeLimitations, implementationLimitationInstructions, LimitationLedger, reviewLimitationInstructions } from '../domain/limitations.js';
import { taskRules } from '../domain/execution-policy.js';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { EnginePhase, Validator, ValidationResult } from '../domain/engine.js';
import type { AgentDefinition, AppConfig, Task, WorkItem } from '../domain/schemas.js';
import { AppError } from '../domain/errors.js';
import { PolicyEngine } from '../domain/policy.js';
import { scopeAgent } from '../domain/ownership.js';
import type { TaskService } from './service.js';
import { ImplementationOutput, ReviewOutput } from './outputs.js';
import type { TaskWorkflows } from './workflows.js';
import { admittedWorkers } from '../workspace/disk-space.js';
import { readyItems, AgentSlots } from './dag-scheduler.js';
import { WorkspaceManager, git } from '../workspace/git.js';
import { originalCheckoutStatus } from '../workspace/status.js';
import { commitSubject } from '../workspace/branches.js';
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
  service: TaskService; preflight(agent: AgentDefinition): Promise<void>; validator: Validator; task: Task; agents: AgentDefinition[]; signal: AbortSignal;
  active(): Promise<Task>;
  move(state: Task['state'], reason: string, patch?: Partial<Pick<Task, 'outcome'>>): Promise<Task>;
  provider(agent: AgentDefinition): AppConfig['providers'][number];
  invoke(phase: EnginePhase, agent: AgentDefinition, prompt: string, schema: z.ZodType, signal: AbortSignal, context: Context): Promise<unknown>;
  workflows: TaskWorkflows;
  prepareEnvironment(cwd: string, commands: Item['validation'], signal: AbortSignal, workItemId: string, feedback?: string): Promise<void>;
  quality(current: Awaited<ReturnType<typeof changes>>, evidence: ValidationResult[], owner: AgentDefinition): Promise<string>;
  onRepair(): number;
  stopping(): boolean;
};

export async function runDag(h: Hooks): Promise<void> {
  const { service, task, agents, signal } = h;
  const rules = taskRules(task);
  const concurrency = service.config.concurrency;
  const plan = task.plan!; const workspace = task.workspace!; const project = await service.store.project(task.projectId);
  if (!plan.integration) throw new AppError('invalid_plan', 'Multi-item execution requires integration instructions');
  const record = async (kind: string, data: unknown) => await service.store.record(task.id, kind, data);
  const sourceStatus = (scanSignal: AbortSignal, workItemId?: string) => originalCheckoutStatus(project.path, {
    signal: scanSignal,
    onRetry: async reason => await record('repository-scan', { state: 'retrying', attempt: 2, reason, ...(workItemId ? { workItemId } : {}) }),
  });
  const originalStatus = await sourceStatus(signal);
  const state = async (itemId: string, state: string, data: Record<string, unknown> = {}) => await record('work-item', { itemId, state, ...data });
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
  for (const agent of [...new Map([...developers.values(), integrator, reviewer].map(a => [a.id, a])).values()]) await h.preflight(agent);
  await assertIntegrationConfig(workspace.path);
  await h.active(); await h.move('running', 'Scheduling approved work items in isolated worktrees');
  for (const item of plan.items) await state(item.id, 'pending', { agentId: item.assignedAgent, dependsOn: item.dependsOn, branch: item.branch, ownedPaths: item.ownedPaths });
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
    await h.active(); if (before) assertHiddenUnchanged(before, await hiddenFiles(context.cwd), context.workItemId === '@integration' ? 'Integration repair' : `Work item ${context.workItemId}`);
    return output;
  };
  const validate = async (currentWorkspace: Workspace, commands: Item['validation'], workerSignal: AbortSignal, itemId: string): Promise<ValidationResult[]> => {
    const cwd = currentWorkspace.path;
    const agent = itemId === '@integration' ? integrator : developers.get(itemId)!;
    await prepare(cwd, commands, workerSignal, itemId);
    return validateWithSetup({ commands, rules,
      digest: async () => (await changes(currentWorkspace, agent)).digest,
      execute: async command => {
        await h.active(); if (workerSignal.aborted) throw new AppError('cancelled', 'Work item cancelled');
        return h.validator.execute(cwd, command, workerSignal, service.config.validationTimeoutMs, rules);
      },
      record: async result => { await record('validation', { workItemId: itemId, ...result }); },
      started: async (command, validationId) => { await record('validation-started', { ...command, validationId, workItemId: itemId, timeoutMs: service.config.validationTimeoutMs }); },
      failed: async (command, validationId, error) => { await record('validation-failed', { ...command, validationId, workItemId: itemId, error }); },
      recover: feedback => prepare(cwd, commands, workerSignal, itemId, feedback),
    });
  };
  const review = async (current: Awaited<ReturnType<typeof changes>>, evidence: ValidationResult[], cwd: string, itemId: string, criteria: unknown, workerSignal: AbortSignal) => {
    for (const file of current.files) await new PolicyEngine().file(reviewer, cwd, file, 'read');
    const combined = itemId === '@integration';
    const currentSourceStatus = await sourceStatus(workerSignal, itemId);
    const workspaceEvidence = {
      isolatedWorktree: cwd !== project.path,
      originalHeadUnchanged: await git(project.path, ['rev-parse', 'HEAD']) === (workspace.originalHead ?? workspace.baseSha),
      originalGitStatusUnchanged: currentSourceStatus === originalStatus,
      originalGitStatusCleanBeforeAndNow: originalStatus === '' && currentSourceStatus === '',
    };
    await record('review-context', { workItemId: itemId, stage: combined ? 'combined' : 'item', workspaceEvidence });
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
    const check = async () => { await h.active(); if (workerSignal.aborted) throw new AppError('cancelled', 'Work item cancelled'); };
    try {
      await check(); await state(item.id, 'creating', { baseSha });
      await record('worktree-intent', { owner: task.id, workItemId: item.id, branch: item.branch, baseSha });
      const ownedWorker = await new WorkspaceManager(service.dataDir).createItem(project, task.id, task.workspace!.branch, item.id, baseSha);
      worker = ownedWorker;
      await state(item.id, 'running', { workspace: worker });
      let feedback = '';
      let completed!: { item: Item; workspace: Workspace; commit: string };
      await h.workflows.repeat(task.id, `item:${item.id}`, async () => {
        await check();
        await implement(developer, `Implement only this work item. Dependency results are already present in this worktree. Do not commit or modify Git metadata.${rules ? ' Do not modify ignored files.' : ' Generated files and setup scripts are permitted. Prepare any new dependencies or generated prerequisites before returning; keep source changes visible to review.'}\nRequest: ${task.request}\nUser acceptance criteria: ${JSON.stringify(task.acceptanceCriteria)}\nWork item: ${JSON.stringify(item)}\n${feedback}`, workerSignal, { cwd: ownedWorker.path, workItemId: item.id });
        const before = await changes(ownedWorker, developer);
        if (!before.files.length) throw new AppError('no_changes', `Work item ${item.id} produced no changes. DevAgents requires a code change for each work item. This item stopped before automated validation and independent review; the task could not complete.`);
        await check(); await state(item.id, 'validating');
        const evidence = await validate(ownedWorker, item.validation, workerSignal, item.id);
        const after = await changes(ownedWorker, developer);
        if (validationFailed(evidence)) feedback = `${describeValidationFailure(evidence)}. Repair failed validation:\n${validationEvidence(evidence)}`;
        else {
          await check(); await state(item.id, 'reviewing');
          const assessment = await review(after, evidence, ownedWorker.path, item.id, item, workerSignal);
          if (assessment.approved && !assessment.findings.length) {
            await check(); const checked = await changes(ownedWorker, developer);
            if (checked.digest !== after.digest) throw new AppError('review_mutated_files', 'Files changed during work item review');
            await state(item.id, 'checkpointing', { files: checked.files });
            await record('item-commit-intent', { workItemId: item.id, workspace: worker, digest: checked.digest });
            const commit = await commitOwned(ownedWorker, checked.files, `DevAgents work item ${item.id} (combined review pending)`);
            await record('item-commit-created', { workItemId: item.id, commit });
            await check(); await state(item.id, 'reviewed', { commit, repairCycles: localRepairs });
            completed = { item, workspace: ownedWorker, commit };
            return true;
          }
          feedback = `Repair independent review findings:\n${JSON.stringify(assessment.findings)}`;
        }
        await check();
        if (localRepairs >= service.config.maxRepairCycles) throw new AppError('repair_limit', `Work item ${item.id} exhausted its repair budget. ${feedback.slice(0, 2000)}`);
        localRepairs++; repair(); await state(item.id, 'repairing', { repairCycles: localRepairs });
        return false;
      });
      return completed;
    } catch (error) {
      // Distinguish why a worker stopped: its own failure, a user cancellation, a service shutdown,
      // or a sibling's failure draining active workers.
      const cause = !workerSignal.aborted ? 'failed' : h.stopping() ? 'interrupted' : signal.aborted ? 'cancelled' : 'aborted';
      await state(item.id, cause, { error: error instanceof Error ? error.message : String(error), repairCycles: localRepairs, ...(cause === 'aborted' ? { reason: 'A sibling work item failed; this worker was drained' } : cause === 'interrupted' ? { reason: 'Service shutdown interrupted this worker' } : {}) });
      throw error;
    }
  };
  const done = new Set<string>(); const started = new Set<string>(); let integrationRepairs = 0;
  const pending = new Map<string, Promise<Awaited<ReturnType<typeof executeItem>> | undefined>>();
  const abort = new AbortController(); const cancel = () => abort.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) abort.abort();
  let failure: unknown;
  const checkScheduling = async () => {
    if (failure) throw failure;
    await h.active();
    if (abort.signal.aborted) throw new AppError('cancelled', 'Work item scheduling stopped');
  };
  await record('work-item-scheduling', { concurrency, strategy: 'rolling' });
  try {
    await h.workflows.repeat(task.id, 'dependency-scheduling', async () => {
      await checkScheduling();
      const nodes = readyItems(plan.items.map(item => ({ ...item, agentId: developers.get(item.id)!.id, agentConcurrency: developers.get(item.id)!.concurrency })), done, concurrency, new Set(pending.keys()));
      if (nodes.length) {
        // Reserve headroom for outstanding workers as well as newly admitted checkouts.
        const capacity = await admittedWorkers(service.dataDir, nodes.length + pending.size, service.config.minFreeDiskBytes).catch(error => {
          if (pending.size && error instanceof AppError && error.code === 'disk_space_low') return 0;
          throw error;
        });
        const admitted = Math.max(0, capacity - pending.size);
        if (admitted < nodes.length) {
          await record('storage-admission', { requestedWorkers: nodes.length, admittedWorkers: admitted, message: 'Reduced parallelism to retain preparation headroom for outstanding workers' });
          nodes.splice(admitted);
        }
      }
      if (nodes.length) {
        // This coordinator alone snapshots and integrates the shared worktree.
        const baseSha = await integrationSnapshot(workspace, integrator);
        await record('dependency-checkpoint', { baseSha, completed: [...done] });
        await checkScheduling();
        for (const node of nodes) {
          started.add(node.id);
          pending.set(node.id, h.workflows.worker(task.id, node.id, () => executeItem(plan.items.find(i => i.id === node.id)!, baseSha, abort.signal).catch(error => {
            failure ??= error; abort.abort(); throw error;
          })).catch(error => {
            failure ??= error; abort.abort(); return undefined;
          }));
        }
      }
      const completed = await Promise.race(pending.values());
      await checkScheduling();
      if (completed) {
        await state(completed.item.id, 'integrating');
        await record('integration-intent', { workItemId: completed.item.id, commit: completed.commit });
        const conflicts = await integrateItem(workspace, completed.workspace, completed.commit, integrator);
        if (conflicts.length) {
          await record('integration-conflict', { workItemId: completed.item.id, files: conflicts, agentId: integrator.id });
          // Read both sides from the unmerged index now: staging the repair later discards them, and a
          // bare "=======" is only a leftover divider when neither side had that many underlines.
          const baselines = await conflictBaselines(workspace.path, conflicts);
          let resolved = false;
          await h.workflows.repeat(task.id, `conflict:${completed.item.id}`, async () => {
            await checkScheduling();
            if (integrationRepairs >= service.config.maxRepairCycles) throw new AppError('integration_conflict', 'Integration conflict exhausted the repair budget; inspect task evidence and any recovery snapshots.');
            integrationRepairs++; repair();
            for (const file of conflicts) await new PolicyEngine().file(integrator, workspace.path, file, 'write');
            await implement(integrator, `Resolve this explicit integration conflict. Preserve all work-item requirements. Edit project files only; do not use Git or commit.${rules ? ' Do not touch ignored files.' : ''} Remove conflict markers.\nUser request: ${task.request}\nPlan: ${JSON.stringify(plan)}\nConflicting files: ${JSON.stringify(conflicts)}`, abort.signal, { cwd: workspace.path, workItemId: '@integration' });
            await changes(workspace, integrator);
            resolved = true;
            for (const file of conflicts) {
              const path = await new PolicyEngine().file(integrator, workspace.path, file, 'write');
              const text = await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
              const problem = unresolvedMarkers(text, baselines.get(file) ?? 0);
              if (problem) { resolved = false; await record('integration-unresolved', { workItemId: completed.item.id, file, problem, repairCycles: integrationRepairs }); }
            }
            if (resolved) {
              await assertIntegrationConfig(workspace.path);
              await git(workspace.path, ['add', '--', ...conflicts]);
              // Content was checked above; staging alone proves nothing, so also confirm Git sees no unmerged entry.
              const unmerged = (await git(workspace.path, ['diff', '--name-only', '--diff-filter=U', '-z'], false)).split('\0').filter(Boolean);
              if (unmerged.length) throw new AppError('integration_conflict', `Unmerged entries remain after repair: ${unmerged.join(', ')}`);
              await record('integration-resolved', { workItemId: completed.item.id, files: conflicts, repairCycles: integrationRepairs });
            }
            return resolved;
          });
        }
        await changes(workspace, integrator);
        await checkScheduling();
        pending.delete(completed.item.id);
        done.add(completed.item.id); await state(completed.item.id, 'completed', { commit: completed.commit });
      }
      return done.size === plan.items.length;
    });
    const commands = [...new Map([...plan.items.flatMap(i => i.validation), ...plan.integration.validation].map(c => [JSON.stringify(c), c])).values()];
    await h.workflows.repeat(task.id, 'combined-validation-review', async () => {
      await h.active(); await h.move('validating', 'Validating combined work-item results');
      const before = await changes(workspace, integrator);
      if (!before.files.length) throw new AppError('no_changes', 'Combined task has no changes. The combined work has no code changes relative to the starting commit. DevAgents stopped before combined validation and independent review; no final task commit was created.');
      const evidence = await validate(workspace, commands, signal, '@integration');
      const after = await changes(workspace, integrator);
      let feedback = '';
      const qualityFeedback = validationFailed(evidence) ? '' : await h.quality(after, evidence, integrator);
      if (validationFailed(evidence) || qualityFeedback) feedback = qualityFeedback || `${describeValidationFailure(evidence)}. Combined validation failed:\n${validationEvidence(evidence)}`;
      else {
        await h.active(); await h.move('reviewing', 'Independent combined review');
        const assessment = await review(after, evidence, workspace.path, '@integration', plan, signal);
        if (assessment.approved && !assessment.findings.length) {
          await h.active(); const checked = await changes(workspace, integrator);
          if (checked.digest !== after.digest) throw new AppError('review_mutated_files', 'Files changed during combined review');
          await h.active(); await h.move('committing', 'Finalizing reviewed combined local commit');
          await record('commit-intent', { branch: workspace.branch, digest: checked.digest, files: checked.files });
          const commit = await commitChanges(project, workspace, checked.files, commitSubject(task.request));
          await record('commit-created', { commit, branch: workspace.branch });
          const reported = ledger.snapshot();
          await h.move('completed', `DAG execution, combined validation and review passed; local commit created${describeLimitations(reported)}`, { outcome: { commit, files: checked.files, summary: plan.summary, repairCycles, ...reported } });
          return true;
        }
        feedback = `Combined review requested repairs:\n${JSON.stringify(assessment.findings)}`;
      }
      await h.active();
      if (integrationRepairs >= service.config.maxRepairCycles) throw new AppError('repair_limit', `Combined integration repair budget exhausted. ${feedback.slice(0, 2000)}`);
      integrationRepairs++; repair(); await h.move('repairing', 'Bounded integration repair requested', { outcome: { repairCycles } });
      await h.move('running', 'Integration agent repairing combined result');
      await implement(integrator, `Repair the combined result within the plan's owned paths. Do not commit or modify Git metadata.${rules ? ' Do not modify ignored files.' : ' Generated files and setup scripts are permitted. Prepare any new dependencies or generated prerequisites before returning; keep source changes visible to review.'}\nRequest: ${task.request}\nPlan: ${JSON.stringify(plan)}\n${feedback}`, signal, { cwd: workspace.path, workItemId: '@integration' });
      return false;
    });
  } catch (error) {
    for (const item of plan.items) if (!done.has(item.id) && !started.has(item.id)) await state(item.id, signal.aborted && !h.stopping() ? 'cancelled' : 'blocked', { reason: h.stopping() ? 'Service shutdown stopped the task before this item started' : 'Task stopped before dependencies completed' });
    throw error;
  } finally {
    abort.abort();
    await Promise.allSettled(pending.values());
    signal.removeEventListener('abort', cancel);
  }
}
