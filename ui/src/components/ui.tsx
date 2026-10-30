import type { ComponentChildren } from 'preact';
import { itemState, taskState, type Tone } from '../format';
import type { TaskSummary } from '../api';

export function Chip({ tone, children, title }: { tone: Tone; children: ComponentChildren; title?: string }) {
  return <span class={`chip ${tone}`} title={title}>{children}</span>;
}
export function StateChip({ task }: { task: Pick<TaskSummary, 'state' | 'error'> }) {
  const s = taskState(task);
  return <Chip tone={s.tone}><span aria-hidden="true">{s.icon}</span>{s.label}</Chip>;
}
export function ItemChip({ state }: { state: string }) {
  const s = itemState(state);
  return <Chip tone={s.tone}><span aria-hidden="true">{s.icon}</span>{s.label}</Chip>;
}
export function Stage({ tone, children }: { tone: Tone; children: ComponentChildren }) { return <span class={`stage ${tone}`}>{children}</span>; }
/** A control that exists in the design but whose backend contract arrives in a later increment. */
export function Later({ label, increment, reason, primary }: { label: string; increment: 'U2' | 'U3'; reason: string; primary?: boolean }) {
  return <button type="button" class={`btn ${primary ? 'primary' : ''}`} disabled aria-disabled="true" title={reason}>{label} <span class="later">· {increment}</span></button>;
}
export function Empty({ title, children }: { title: string; children?: ComponentChildren }) {
  return <div class="empty"><b>{title}</b>{children}</div>;
}
export function Skeleton({ rows = 3, label = 'Loading' }: { rows?: number; label?: string }) {
  return <div class="card pad" aria-busy="true" aria-label={label} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
    <div class="sk" style={{ width: '45%', height: '20px' }} />
    {Array.from({ length: rows }, (_, i) => <div key={i} class="sk" style={{ width: `${90 - i * 12}%` }} />)}
  </div>;
}
export function ErrorNote({ message }: { message: string }) {
  return <div class="note bad" role="alert"><b>Could not load.</b> {message}</div>;
}
export function Card({ title, right, children, tone, foot }: { title?: ComponentChildren; right?: ComponentChildren; children: ComponentChildren; tone?: 'warn' | 'bad' | undefined; foot?: ComponentChildren }) {
  return <section class={`card ${tone ?? ''}`}>
    {title !== undefined && <div class="card-head"><b>{title}</b>{right}</div>}
    {children}
    {foot !== undefined && <div class="card-foot">{foot}</div>}
  </section>;
}
export function Code({ children }: { children: ComponentChildren }) { return <code>{children}</code>; }
export function Pre({ text }: { text: string }) { return <pre class="evidence">{text}</pre>; }
export function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
