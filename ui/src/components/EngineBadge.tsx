/** Small engine marks; labels remain available to assistive technology and on hover. */
export function EngineBadge({ engine }: { engine?: string | undefined }) {
  const known = engine === 'codex' || engine === 'claude-code';
  const label = engine === 'codex' ? 'Codex' : engine === 'claude-code' ? 'Claude' : engine && engine !== 'default' ? engine : 'not recorded';
  return <span class={`engine-badge ${known ? engine : 'unknown'}`} role="img" aria-label={`Engine: ${label}`} title={`Engine: ${label}`}>
    {engine === 'codex' ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 4 4 4-4 4m6 0h4" /></svg>
      : engine === 'claude-code' ? <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M3.4 12.6l9.2-9.2M5.5 2l5 12M2 10.5l12-5" /></svg>
      : <span aria-hidden="true">?</span>}
  </span>;
}
