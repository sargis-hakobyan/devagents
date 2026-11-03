import type { ExecutionEntry } from '../../src/domain/execution';

/** Keep agent handoffs prominent; adjacent automated checks share one expandable row. */
export function executionRows(entries: ExecutionEntry[]): { entry: ExecutionEntry; checks: ExecutionEntry[] }[] {
  const rows: { entry: ExecutionEntry; checks: ExecutionEntry[] }[] = [];
  for (const entry of entries) {
    const previous = rows[rows.length - 1];
    if (entry.kind === 'validation' && previous?.entry.kind === 'validation') previous.checks.push(entry);
    else rows.push({ entry, checks: entry.kind === 'validation' ? [entry] : [] });
  }
  return rows;
}
