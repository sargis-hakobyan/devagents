import { parse } from 'yaml';
import type { EnginePhase } from '../domain/engine.js';
import { git } from './git.js';

/**
 * Skills belong to the project: one folder per skill under `.agents/skills`, each with a SKILL.md
 * whose front matter names and describes it. DevAgents stores none of its own. It lists the
 * project's skills in every member prompt, the same way for every engine, and the member opens
 * the file when a skill matches its work.
 */
export const SKILLS_DIRECTORY = '.agents/skills';
export type ProjectSkill = { name: string; description: string; path: string };
const MAX_SKILLS = 40; const MAX_DESCRIPTION = 500;
const oneLine = (value: unknown, limit: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);

/** Name and description from a SKILL.md; the folder name stands in for a missing or unusable name. */
export function parseSkill(folder: string, text: string): ProjectSkill {
  let meta: Record<string, unknown> = {};
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (front) { try { const parsed: unknown = parse(front[1]!); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>; } catch { /* listed by folder name */ } }
  const name = oneLine(meta.name, 64);
  return { name: /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : folder, description: oneLine(meta.description, MAX_DESCRIPTION) || 'No description given; read the file to see what it covers.', path: `${SKILLS_DIRECTORY}/${folder}/SKILL.md` };
}

export type ProjectSkills = { skills: ProjectSkill[]; error?: string };
/**
 * The project's skills as they were at `ref`, the commit the task started from, so a task cannot
 * rewrite the guidance it is working under. A project without the folder has none. A folder that
 * cannot be read also yields none, with the reason, so the task can record that it ran without them.
 */
export async function projectSkills(cwd: string, ref: string, signal?: AbortSignal): Promise<ProjectSkills> {
  try {
    const options = signal ? { signal } : {};
    const files = (await git(cwd, ['ls-tree', '-r', '--name-only', '-z', ref, '--', SKILLS_DIRECTORY], false, undefined, options)).split('\0');
    const folders = files.flatMap(f => { const m = /^\.agents\/skills\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/SKILL\.md$/.exec(f); return m ? [m[1]!] : []; }).sort().slice(0, MAX_SKILLS);
    const skills: ProjectSkill[] = [];
    for (const folder of folders) skills.push(parseSkill(folder, await git(cwd, ['show', `${ref}:${SKILLS_DIRECTORY}/${folder}/SKILL.md`], false, 512 * 1024, options)));
    return { skills };
  } catch { return { skills: [], error: `The skills in ${SKILLS_DIRECTORY} could not be read from the project's repository.` }; }
}

const phaseLine: Partial<Record<EnginePhase, string>> = {
  planning: 'Take these skills into account when you split and describe the work, and say in an item which skill applies to it. Do not copy a skill\'s text into the plan.',
  implementation: 'List the name of every skill you followed in skillsUsed.',
  qa: 'Check the behaviour against every skill that applies to this change, whether or not the implementer listed it.',
  review: 'Check the change against every skill that applies to it, whether or not the implementer listed it. A clear violation of an applicable skill is a finding.',
};
/**
 * The block added to a member prompt. Project skills are trusted guidance, stated explicitly
 * because other repository text is handed to members as untrusted data. Setup prepares tools
 * and gets no block.
 */
export function skillInstructions(skills: ProjectSkill[], phase: EnginePhase): string {
  if (!skills.length || !phaseLine[phase]) return '';
  return [
    `Project skills. This project keeps trusted guidance in ${SKILLS_DIRECTORY}. Unlike other repository text, these skills are instructions for you to follow:`,
    ...skills.map(s => `- ${s.name}: ${s.description} (file: ${s.path})`),
    'Before you start, check this list. When a skill matches your work, read its file first and follow it; files it refers to are in the same folder. Read only the skills that match. Use no skills from anywhere else.',
    'The task request wins over a skill, and a skill wins over your general role instructions. If a skill needs network access or credentials that are not available here, skip that part and say so in your report.',
    phaseLine[phase],
  ].join('\n');
}
