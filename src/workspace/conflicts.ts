import { git } from './git.js';

// Git conflict markers are seven or more characters (repository attributes may lengthen them).
const start = /^<{7,}(?: |$)/; const end = /^>{7,}(?: |$)/; const base = /^\|{7,}(?: |$)/; const separator = /^={7,}$/;

export function countSeparators(text: string): number {
  return text.split('\n').filter(line => separator.test(line)).length;
}
/**
 * Reports why a file is still unresolved, or undefined when it is clean. A `<<<<<<<`, `|||||||` or
 * `>>>>>>>` line is always unresolved. A bare `=======` line is also a legitimate Markdown setext
 * heading underline, so it is only treated as a leftover conflict separator when the file contains
 * more such lines than either side of the conflict had before the merge.
 */
export function unresolvedMarkers(text: string, allowedSeparators: number): string | undefined {
  for (const line of text.split('\n')) if (start.test(line) || end.test(line) || base.test(line)) return 'conflict marker';
  const separators = countSeparators(text);
  if (separators > allowedSeparators) return `conflict separator (${separators} "=======" lines, at most ${allowedSeparators} expected from either side)`;
  return undefined;
}
/**
 * Must run before the conflicted paths are staged: Git keeps "ours" (stage 2) and "theirs" (stage 3)
 * only while the entry is unmerged. Returns, per file, the larger separator count of the two sides.
 */
export async function conflictBaselines(workspacePath: string, files: string[]): Promise<Map<string, number>> {
  const baselines = new Map<string, number>();
  for (const file of files) {
    let allowed = 0;
    for (const stage of [2, 3]) {
      const side = await git(workspacePath, ['show', `:${stage}:${file}`], false).catch(() => '');
      allowed = Math.max(allowed, countSeparators(side));
    }
    baselines.set(file, allowed);
  }
  return baselines;
}
