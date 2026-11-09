import { useEffect, useState } from 'preact/hooks';

// Official catalogs checked 2026-11-03. These are suggestions, not account entitlements.
// https://learn.chatgpt.com/docs/models
// https://platform.claude.com/docs/en/models/overview
const models: Record<string, readonly { id: string; name: string }[]> = {
  codex: [
    { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
    { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
    { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra' },
    { id: 'gpt-6-luna', name: 'GPT-6 Luna' },
  ],
  'claude-code': [
    { id: 'claude-fable-5-1', name: 'Claude Fable 5.1' },
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  ],
};

export function ModelSelect({ engine, value, resolved, onChange }: { engine: string; value: string; resolved: string; onChange: (model: string) => void }) {
  const choices = models[engine] ?? [];
  // Opening custom entry does not overwrite an existing model before the user types.
  const [customEntry, setCustomEntry] = useState(false);
  useEffect(() => setCustomEntry(false), [value]);
  const custom = customEntry || value !== 'default' && !choices.some(m => m.id === value);
  return <div class="field">
    <label class="field"><span>Model</span><select value={custom ? '__custom__' : value} onChange={e => {
      const next = e.currentTarget.value;
      setCustomEntry(next === '__custom__');
      if (next !== '__custom__') onChange(next);
    }}>
      <option value="default">Default · inherit engine settings</option>
      {choices.map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}
      <option value="__custom__">Custom model ID…</option>
    </select></label>
    {custom && <label class="field"><span>Custom model ID</span><input value={value === 'default' ? '' : value} maxLength={200} placeholder="Enter an exact model ID" onInput={e => onChange(e.currentTarget.value.trim() || 'default')} /></label>}
    <span class="hint wrap-anywhere">Resolved: {resolved}. Listed models come from the official catalogs; account access is not verified.</span>
  </div>;
}
