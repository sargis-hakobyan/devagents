import { useEffect, useState } from 'preact/hooks';
import { api, resources, type ModelCatalog } from '../api';
import { usePoll } from '../state';
import { formatTime } from '../format';

// Built-in fallback, used until a list has been loaded from the engine. Official catalogs checked 2026-11-03.
// https://learn.chatgpt.com/docs/models
// https://platform.claude.com/docs/en/models/overview
const BUILT_IN_DATE = '3 Nov 2026';
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
const engineName = (engine: string) => engine === 'claude-code' ? 'Claude' : engine === 'codex' ? 'Codex' : engine;

export function ModelSelect({ engine, value, resolved, onChange }: { engine: string; value: string; resolved: string; onChange: (model: string) => void }) {
  // Saved lists are read from the service; an engine is asked only when Refresh list is pressed.
  const saved = usePoll(resources.teamModels.key, resources.teamModels.load, resources.teamModels.intervalMs);
  const [loaded, setLoaded] = useState<ModelCatalog | undefined>(); const [refreshing, setRefreshing] = useState(false); const [failure, setFailure] = useState<string | undefined>();
  const catalog = loaded ?? saved.data?.find(c => c.engine === engine);
  const choices = catalog?.models ?? models[engine] ?? [];
  const isNew = (id: string) => catalog?.newIds.includes(id) ?? false;
  // Opening custom entry does not overwrite an existing model before the user types.
  const [customEntry, setCustomEntry] = useState(false);
  useEffect(() => setCustomEntry(false), [value]);
  const custom = customEntry || value !== 'default' && !choices.some(m => m.id === value);
  const refresh = async () => {
    setRefreshing(true); setFailure(undefined);
    try { setLoaded(await api<ModelCatalog>('/teams/models/refresh', { method: 'POST', body: { engine }, timeoutMs: 45000 })); saved.reload(); }
    catch (e) { setFailure(e instanceof Error ? e.message : String(e)); }
    finally { setRefreshing(false); }
  };
  return <div class="field">
    <label class="field"><span>Model</span><select value={custom ? '__custom__' : value} onChange={e => {
      const next = e.currentTarget.value;
      setCustomEntry(next === '__custom__');
      if (next !== '__custom__') onChange(next);
    }}>
      <option value="default">Default · inherit engine settings</option>
      {choices.map(m => <option key={m.id} value={m.id}>{m.name} · {m.id}{isNew(m.id) ? ' · new' : ''}</option>)}
      <option value="__custom__">Custom model ID…</option>
    </select></label>
    {custom && <label class="field"><span>Custom model ID</span><input value={value === 'default' ? '' : value} maxLength={200} placeholder="Enter an exact model ID" onInput={e => onChange(e.currentTarget.value.trim() || 'default')} /></label>}
    <span class="hint wrap-anywhere">Resolved: {resolved}. {catalog ? `List loaded from ${engineName(engine)} ${formatTime(catalog.loadedAt)}` : `Built-in list from ${BUILT_IN_DATE}`}; account access is not verified. <button type="button" class="link-button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? 'Loading…' : 'Refresh list'}</button></span>
    {failure && <span class="hint diag-error" role="alert">{failure} {catalog ? 'Showing the list loaded before.' : 'Showing the built-in list.'}</span>}
  </div>;
}
