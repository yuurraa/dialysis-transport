import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Option { value: string; label: string }

/** Bounded combobox with optional pinned search inside the current dialog's top layer. */
export function Dropdown({ id, label, options, value, onChange, placeholder = 'Select an option', disabled = false, required = false, searchable = false }: {
  id: string; label: string; options: Option[]; value: string; onChange: (value: string) => void;
  placeholder?: string; disabled?: boolean; required?: boolean; searchable?: boolean;
}) {
  const listId = useId();
  const control = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const search = useRef({ text: '', time: 0 });
  const scrollActive = useRef(true);
  const [expanded, setExpanded] = useState(false);
  const [term, setTerm] = useState('');
  const visibleOptions = searchable ? options.filter(option => option.label.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase())) : options;
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number }>();
  const selected = options.find(option => option.value === value);
  function open() {
    if (disabled || !options.length) return;
    scrollActive.current = true;
    setTerm('');
    setActive(Math.max(0, options.findIndex(option => option.value === value)));
    setExpanded(true);
  }
  function choose(index: number) {
    if (!visibleOptions[index]) return;
    onChange(visibleOptions[index].value);
    setExpanded(false);
    control.current?.focus();
  }
  useLayoutEffect(() => {
    if (!expanded) return;
    function position() {
      const button = control.current!;
      const rect = button.getBoundingClientRect();
      const viewport = window.visualViewport;
      const visibleTop = viewport?.offsetTop ?? 0;
      const visibleBottom = visibleTop + (viewport?.height ?? innerHeight);
      const topLimit = visibleTop + 8;
      const bottomLimit = visibleBottom - 8;
      const below = Math.max(0, bottomLimit - rect.bottom - 8);
      const above = Math.max(0, rect.top - topLimit - 8);
      const upwards = below < Math.min(360, above);
      const maxHeight = Math.min(360, (viewport?.height ?? innerHeight) * .6, upwards ? above : below);
      const visibleLeft = viewport?.offsetLeft ?? 0;
      const width = Math.min(rect.width, (viewport?.width ?? innerWidth) - 16);
      const left = Math.max(visibleLeft + 8, Math.min(rect.left, visibleLeft + (viewport?.width ?? innerWidth) - width - 8));
      setPlacement({ left, width, maxHeight,
        ...(upwards ? { bottom: innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }) });
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !control.current?.contains(event.target) && !popup.current?.contains(event.target)) setExpanded(false);
    }
    function scrolled(event: Event) { if (event.target instanceof Node && !popup.current?.contains(event.target)) position(); }
    position();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', position);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [expanded]);
  const popupReady = expanded && !!placement;
  useLayoutEffect(() => {
    if (!popupReady) return;
    const element = popup.current!;
    // Escape dialog clipping while keeping the popup inside its modal's DOM tree.
    element.showPopover();
    return () => { if (element.isConnected && element.matches(':popover-open')) element.hidePopover(); };
  }, [popupReady]);
  useEffect(() => {
    if (!expanded || !placement || !scrollActive.current) return;
    const list = document.getElementById(listId);
    const option = document.getElementById(`${listId}-${active}`);
    if (!list || !option) return;
    const listRect = list.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    // Scroll only this list for keyboard/search navigation; never its ancestors.
    if (optionRect.top < listRect.top) list.scrollTop -= listRect.top - optionRect.top;
    else if (optionRect.bottom > listRect.bottom) list.scrollTop += optionRect.bottom - listRect.bottom;
  }, [expanded, placement, active, listId, term]);
  useEffect(() => { if (disabled) setExpanded(false); }, [disabled]);
  return <>
    <button id={id} ref={control} className="bounded-select" type="button" role="combobox" aria-label={label} aria-required={required}
      aria-haspopup="listbox" aria-expanded={expanded} aria-controls={listId} aria-activedescendant={expanded && visibleOptions.length ? `${listId}-${active}` : undefined}
      disabled={disabled || !options.length} onClick={() => expanded ? setExpanded(false) : open()}
      onBlur={event => { if (!popup.current?.contains(event.relatedTarget)) setExpanded(false); }}
      onKeyDown={event => {
        if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
        else if (event.key === 'Tab') setExpanded(false);
        else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (expanded) choose(active); else open(); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          scrollActive.current = true;
          if (!expanded) open();
          else if (visibleOptions.length) setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + visibleOptions.length) % visibleOptions.length);
        } else if (expanded && ['Home', 'End'].includes(event.key)) { event.preventDefault(); scrollActive.current = true; setActive(event.key === 'Home' ? 0 : visibleOptions.length - 1); }
        else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now();
          search.current = { text: (now - search.current.time < 700 ? search.current.text : '') + event.key.toLocaleLowerCase(), time: now };
          const index = visibleOptions.findIndex(option => option.label.toLocaleLowerCase().startsWith(search.current.text));
          if (index >= 0) { event.preventDefault(); scrollActive.current = true; setExpanded(true); setActive(index); }
        }
      }}><span>{selected?.label ?? placeholder}</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg></button>
    {expanded && placement && createPortal(<div ref={popup} popover="manual" className="bounded-options" style={placement}
      onBlur={event => { if (!popup.current?.contains(event.relatedTarget) && !control.current?.contains(event.relatedTarget)) setExpanded(false); }}>
      {searchable && <div className="bounded-options-search"><input type="search" aria-label={`Search ${label.toLowerCase()}`} placeholder={`Search ${label.toLowerCase()}`} maxLength={100} value={term}
        onChange={event => { scrollActive.current = true; setTerm(event.target.value); setActive(0); }}
        onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setExpanded(false); control.current?.focus(); }
          else if (event.key === 'Enter') { event.preventDefault(); choose(active); }
          else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); scrollActive.current = true; setActive(event.key === 'ArrowDown' ? 0 : Math.max(0, visibleOptions.length - 1)); control.current?.focus(); }
        }} /></div>}
      <div id={listId} className="bounded-options-list" role="listbox" aria-label={label}>
      {visibleOptions.map((option, index) => <div id={`${listId}-${index}`} key={option.value} role="option" aria-selected={value === option.value} data-value={option.value}
        onMouseDown={event => event.preventDefault()} className={index === active ? 'is-active' : undefined} onPointerMove={() => { scrollActive.current = false; setActive(index); }} onClick={() => choose(index)}>{option.label}</div>)}
      </div>
      {!visibleOptions.length && <p className="bounded-options-empty" role="status">No matching options.</p>}
    </div>, control.current?.closest('dialog') ?? document.body)}
  </>;
}
