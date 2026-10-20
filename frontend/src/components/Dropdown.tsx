import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Option { value: string; label: string }

/** Select-only combobox: a bounded list inside the current dialog's top layer. */
export function Dropdown({ id, label, options, value, onChange, placeholder = 'Select an option', disabled = false, required = false }: {
  id: string; label: string; options: Option[]; value: string; onChange: (value: string) => void;
  placeholder?: string; disabled?: boolean; required?: boolean;
}) {
  const listId = useId();
  const control = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const [expanded, setExpanded] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number }>();
  const selected = options.find(option => option.value === value);
  function open() {
    if (disabled || !options.length) return;
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
    setExpanded(true);
  }
  function choose(index: number) {
    if (!options[index]) return;
    onChange(options[index].value);
    setExpanded(false);
    control.current?.focus();
  }
  useLayoutEffect(() => {
    if (!expanded) return;
    function position() {
      const button = control.current!;
      const rect = button.getBoundingClientRect();
      const dialog = button.closest('dialog')?.getBoundingClientRect();
      const header = button.closest('dialog')?.querySelector('.overlay-header')?.getBoundingClientRect();
      const footer = button.closest('dialog')?.querySelector('.overlay-footer')?.getBoundingClientRect();
      const topLimit = Math.max(8, header?.bottom ?? dialog?.top ?? 0);
      const bottomLimit = Math.min(innerHeight - 8, footer?.top ?? dialog?.bottom ?? innerHeight);
      const below = Math.max(0, bottomLimit - rect.bottom - 8);
      const above = Math.max(0, rect.top - topLimit - 8);
      const upwards = below < Math.min(224, above);
      const maxHeight = Math.min(224, innerHeight * .35, upwards ? above : below);
      setPlacement({ left: Math.max(8, rect.left), width: Math.min(rect.width, innerWidth - 16), maxHeight,
        ...(upwards ? { bottom: innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !control.current?.contains(event.target) && !popup.current?.contains(event.target)) setExpanded(false);
    }
    function scrolled(event: Event) { if (event.target instanceof Node && !popup.current?.contains(event.target)) position(); }
    position();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', position);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', position);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [expanded]);
  useEffect(() => {
    if (expanded && placement) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [expanded, placement, active, listId]);
  useEffect(() => { if (disabled) setExpanded(false); }, [disabled]);
  return <>
    <button id={id} ref={control} className="bounded-select" type="button" role="combobox" aria-label={label} aria-required={required}
      aria-haspopup="listbox" aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
      disabled={disabled || !options.length} onClick={() => expanded ? setExpanded(false) : open()}
      onBlur={event => { if (!popup.current?.contains(event.relatedTarget)) setExpanded(false); }}
      onKeyDown={event => {
        if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
        else if (event.key === 'Tab') setExpanded(false);
        else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (expanded) choose(active); else open(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!expanded) open();
          else setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
        } else if (expanded && ['Home', 'End'].includes(event.key)) { event.preventDefault(); setActive(event.key === 'Home' ? 0 : options.length - 1); }
        else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now();
          search.current = { text: (now - search.current.time < 700 ? search.current.text : '') + event.key.toLocaleLowerCase(), time: now };
          const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(search.current.text));
          if (index >= 0) { event.preventDefault(); setExpanded(true); setActive(index); }
        }
      }}><span>{selected?.label ?? placeholder}</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
    {expanded && placement && createPortal(<div ref={popup} id={listId} className="bounded-options" role="listbox" aria-label={label} style={placement}
      onMouseDown={event => event.preventDefault()}>
      {options.map((option, index) => <div id={`${listId}-${index}`} key={option.value} role="option" aria-selected={value === option.value} data-value={option.value}
        className={index === active ? 'is-active' : undefined} onPointerMove={() => setActive(index)} onClick={() => choose(index)}>{option.label}</div>)}
    </div>, control.current?.closest('dialog') ?? document.body)}
  </>;
}
