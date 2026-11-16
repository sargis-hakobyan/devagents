import { useEffect, useRef, useState } from 'preact/hooks';

export type Choice = { id: string; name: string };
type Found = { state: 'idle' } | { state: 'loading' } | { state: 'ok'; items: Choice[] } | { state: 'bad'; text: string };

/**
 * A text field that looks choices up as you type. The list comes from `search`, so it works for
 * sets too large to load at once. With `free`, text that matches no choice is accepted as typed.
 * Keyboard: arrows move, Enter chooses, Escape closes and restores, an emptied field clears the value.
 */
export function Autocomplete({ id, what, value, onChange, search, placeholder, disabled, free, describe = c => c.name }: {
  id: string; /** What is being chosen, for the clear button: "project", "assignee". */ what: string; value: Choice | undefined; onChange: (next: Choice | undefined) => void; search: (query: string) => Promise<Choice[]>;
  placeholder: string; disabled?: boolean; free?: boolean; describe?: (choice: Choice) => string;
}) {
  const shown = value ? describe(value) : '';
  const [text, setText] = useState(shown); const [open, setOpen] = useState(false); const [active, setActive] = useState(0);
  const [found, setFound] = useState<Found>({ state: 'idle' });
  const sequence = useRef(0); const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined); const searcher = useRef(search); searcher.current = search;
  // The field follows the value whenever the value changes from outside, for example when another field resets it.
  useEffect(() => { setText(shown); }, [shown]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); sequence.current++; }, []);

  const look = (query: string, delay: number) => {
    const run = ++sequence.current; if (timer.current) clearTimeout(timer.current);
    setFound({ state: 'loading' });
    timer.current = setTimeout(() => {
      searcher.current(query).then(
        items => { if (run === sequence.current) { setFound({ state: 'ok', items }); setActive(0); } },
        error => { if (run === sequence.current) setFound({ state: 'bad', text: error instanceof Error ? error.message : String(error) }); });
    }, delay);
  };
  const close = () => { setOpen(false); sequence.current++; if (timer.current) clearTimeout(timer.current); };
  const choose = (choice: Choice | undefined) => { close(); setText(choice ? describe(choice) : ''); if (choice?.id !== value?.id) onChange(choice); };
  /** Leaving the field settles it: empty clears, free text is taken as typed, anything else goes back to the value. */
  const settle = () => {
    const typed = text.trim();
    if (!typed) return choose(undefined);
    if (typed === shown) return close();
    if (free) return choose({ id: typed, name: typed });
    close(); setText(shown);
  };
  const items = found.state === 'ok' ? found.items : [];
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) { setOpen(true); look(text === shown ? '' : text.trim(), 0); return; }
      if (items.length) setActive(a => (a + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
    } else if (event.key === 'Enter') {
      if (!open) return;
      // Enter picks from the list instead of submitting the form around it.
      event.preventDefault();
      if (items[active]) choose(items[active]); else settle();
    } else if (event.key === 'Escape' && open) { event.preventDefault(); close(); setText(shown); }
  };
  const list = `${id}-list`;
  return <div class="ac">
    <input id={id} type="text" role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={list}
      aria-activedescendant={open && items[active] ? `${id}-option-${active}` : undefined} autocomplete="off" spellcheck={false}
      value={text} placeholder={placeholder} disabled={disabled}
      onFocus={e => { e.currentTarget.select(); setOpen(true); look('', 0); }}
      onInput={e => { const next = e.currentTarget.value; setText(next); setOpen(true); look(next.trim(), 250); }}
      onKeyDown={onKey} onBlur={settle} />
    {value && !disabled && <button type="button" class="ac-clear" aria-label={`Clear ${what}`} onMouseDown={e => e.preventDefault()} onClick={() => choose(undefined)}>×</button>}
    {open && <ul id={list} class="ac-list" role="listbox">
      {found.state === 'bad' ? <li class="ac-note bad" role="alert">{found.text}</li>
        : found.state !== 'ok' ? <li class="ac-note">Searching…</li>
        : items.length === 0 ? <li class="ac-note">{free && text.trim() && text.trim() !== shown ? `No match. Press Enter to use “${text.trim()}”.` : 'No match.'}</li>
        : items.map((item, index) => <li key={item.id} id={`${id}-option-${index}`} role="option" aria-selected={index === active} class={index === active ? 'on' : ''}
            // Mouse down, not click: the field must not lose focus and settle before the choice lands.
            onMouseDown={e => { e.preventDefault(); choose(item); }} onMouseEnter={() => setActive(index)}>{describe(item)}</li>)}
    </ul>}
  </div>;
}
