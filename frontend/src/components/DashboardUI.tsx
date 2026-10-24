import { Toast } from './Toast';
import { useId, useLayoutEffect, useRef, useState, type FormEventHandler, type ReactNode, type Ref } from 'react';

export function InfoButton({ label, onClick, disabled, buttonRef }: {
  label: string; onClick: () => void; disabled?: boolean; buttonRef?: Ref<HTMLButtonElement>;
}) {
  return <button className="list-info-control" type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} ref={buttonRef}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v6" /><circle cx="12" cy="7" r=".8" fill="currentColor" stroke="none" /></svg>
  </button>;
}

/** Shared heading for dashboard pages and sections; actions wrap below on small screens. */
export function PageHeading({ id, title, description, eyebrow, actions, level = 1 }: {
  id: string; title: string; description?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode; level?: 1 | 2;
}) {
  const Heading = level === 1 ? 'h1' : 'h2';
  return <header className="dashboard-section-heading page-heading">
    <div><Heading id={id}>{title}</Heading>{eyebrow && <p className="dashboard-eyebrow">{eyebrow}</p>}{description && <p className="page-description">{description}</p>}</div>
    {actions && <div className="page-heading-actions">{actions}</div>}
  </header>;
}

/** Native modal with one scrolling body, persistent controls, and restored keyboard focus. */
export function Overlay({ title, description, children, footer, onClose, onSubmit, busy = false, className = '', noValidate = false, error, onDismissError }: {
  title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode;
  error?: string; onDismissError?: () => void; noValidate?: boolean;
  onClose: () => void; onSubmit?: FormEventHandler<HTMLFormElement>; busy?: boolean; className?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useLayoutEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    heading.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      if (element.open) element.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  useLayoutEffect(() => { heading.current?.focus(); }, [title]);
  const content = <><div className="overlay-body">{children}</div><footer className="overlay-footer patient-actions">{footer ?? <button type="button" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}>Close</button>}</footer></>;
  return <dialog className={`dashboard-dialog ${className}`} ref={dialog} aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} aria-busy={busy}
    onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled), a[href]'))
        .filter(element => element.getClientRects().length > 0);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) event.preventDefault();
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget || busy) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}>
    {error && <div className="toast-region"><Toast key={error} message={error} urgent onDismiss={() => onDismissError?.()} /></div>}
    <header className="overlay-header"><div><h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2>{description && <p id={descriptionId} className="page-description">{description}</p>}</div>
    </header>
    {onSubmit ? <form className="overlay-content patient-form" onSubmit={onSubmit} noValidate={noValidate}>{content}</form> : <div className="overlay-content">{content}</div>}
  </dialog>;
}

/** Viewport-pinned pagination shared by the three record lists. */
export function ListPagination({ children, label, page, hasNext, disabled, onPageChange, actions, leadingActions }: {
  children: ReactNode; label: string; page: number; hasNext: boolean; disabled: boolean; onPageChange: (page: number) => void; actions?: ReactNode; leadingActions?: ReactNode;
}) {
  const footer = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = footer.current!;
    const main = element.closest<HTMLElement>('.dashboard-main')!;
    const measure = () => {
      main.style.setProperty('--list-pagination-height', `${element.getBoundingClientRect().height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element, { box: 'border-box' });
    return () => {
      observer.disconnect();
      main.style.removeProperty('--list-pagination-height');
    };
  }, []);
  return <div ref={footer} className="patients-pagination" aria-label={label}><span>{children}</span><div className="patient-actions">
    {leadingActions}
    {actions ?? <><button type="button" aria-label="Previous" title="Previous page" disabled={disabled || page <= 1} onClick={() => onPageChange(page - 1)}>{'<'}</button>
    <button type="button" aria-label="Next" title="Next page" disabled={disabled || !hasNext} onClick={() => onPageChange(page + 1)}>{'>'}</button></>}
  </div></div>;
}

/** The same search/filter/sort order is used by every record list. */
export function ListToolbar({ search, onSearch, label, placeholder, filterCount, onFilter, onSort, sortLabel }: {
  search: string; onSearch: (value: string) => void; label: string; placeholder: string;
  filterCount: number; onFilter: () => void; onSort?: () => void; sortLabel?: string;
}) {
  const toolbar = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 760px)').matches);
  useLayoutEffect(() => {
    const media = window.matchMedia('(max-width: 760px)');
    const resized = () => setCompact(media.matches);
    media.addEventListener('change', resized);
    const header = document.querySelector('.dashboard-header');
    if (!header) return () => media.removeEventListener('change', resized);
    const measure = () => toolbar.current?.style.setProperty('--list-header-height', `${header.getBoundingClientRect().height}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => { observer.disconnect(); media.removeEventListener('change', resized); };
  }, []);
  return <div ref={toolbar} className="list-toolbar" role="group" aria-label={onSort ? "Search, filter and sort records" : "Search and filter records"}>
    <label className="patient-search"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
      <input type="search" aria-label={label} placeholder={compact ? label.replace('treatment ', '') : placeholder} title={placeholder} maxLength={100} value={search} onChange={event => onSearch(event.target.value)} />
    </label>
    <button className="list-tool-button trip-filter-button" type="button" aria-label="Filters" aria-haspopup="dialog" title={filterCount ? `Filters (${filterCount} active)` : 'Filters'} onClick={onFilter}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16l-6 7v6l-4 2v-8z" /></svg>
      {filterCount > 0 && <span className="trip-filter-badge" aria-label={`${filterCount} active filters`}>{filterCount}</span>}
    </button>
    {onSort && <button className="list-tool-button" type="button" aria-label="Sort" aria-haspopup="dialog" title={`Sort: ${sortLabel ?? ''}`} onClick={onSort}>
      <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4v16m-4-4 4 4 4-4M16 20V4m-4 4 4-4 4 4" /></svg>
    </button>}
  </div>;
}

export function ChoiceGroup({ label, value, options, onChange, multiple = false }: {
  label: string; value: string; options: readonly { value: string; label: string; title?: string }[]; onChange: (value: string) => void; multiple?: boolean;
}) {
  const name = useId();
  function choose(next: string) {
    if (!multiple) { onChange(next); return; }
    const selected = new Set(value === 'all' ? options.map(option => option.value) : value.split(','));
    if (selected.has(next)) selected.delete(next); else selected.add(next);
    if (!selected.size) return;
    onChange(selected.size === options.length ? 'all' : options.filter(option => selected.has(option.value)).map(option => option.value).join(','));
  }
  return <fieldset className="list-choice-group"><legend>{label}</legend><div className="list-choices">
    {options.map(option => <label key={option.value} className="list-choice" title={option.title}><input type={multiple ? "checkbox" : "radio"} name={name} value={option.value} checked={multiple ? value === 'all' || value.split(',').includes(option.value) : value === option.value} onChange={() => choose(option.value)} /><span>{option.label}</span></label>)}
  </div></fieldset>;
}

export interface SortOption { value: string; label: string; ascending?: string; descending?: string }

export function sortOrderLabel(option: SortOption | undefined, order: string) {
  return order === 'desc' ? option?.descending ?? 'Z–A' : option?.ascending ?? 'A–Z';
}

export function sortSummary(options: readonly SortOption[], sort: string, order: string) {
  const option = options.find(item => item.value === sort);
  return `${option?.label ?? sort} · ${sortOrderLabel(option, order)}`;
}

export function SortOverlay({ sort, order, options, defaultSort, defaultOrder, onClose, onApply }: {
  sort: string; order: string; options: readonly SortOption[]; defaultSort: string; defaultOrder: 'asc' | 'desc';
  onClose: () => void; onApply: (sort: string, order: 'asc' | 'desc') => void;
}) {
  const [field, setField] = useState(sort);
  const [direction, setDirection] = useState(order);
  const selected = options.find(option => option.value === field);
  return <Overlay title="Sort records" description="Choose a field and its order." className="list-options-dialog" onClose={onClose}
    onSubmit={event => { event.preventDefault(); onApply(field, direction as 'asc' | 'desc'); }}
    footer={<><button className="patient-primary" type="submit">Apply Sort</button><button type="button" onClick={() => { setField(defaultSort); setDirection(defaultOrder); }}>Reset</button><button type="button" onClick={onClose}>Cancel</button></>}>
    <ChoiceGroup label="Sort by" value={field} options={options} onChange={setField} />
    <ChoiceGroup label="Order" value={direction} options={[{ value: 'asc', label: 'Ascending', title: sortOrderLabel(selected, 'asc') }, { value: 'desc', label: 'Descending', title: sortOrderLabel(selected, 'desc') }]} onChange={setDirection} />
    <p className="list-choice-hint" aria-live="polite">{selected?.label}: {sortOrderLabel(selected, direction)}.</p>
  </Overlay>;
}

/** A consistent recovery state keeps the list's flat visual language. */
export function ListError({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return <div className="list-error-state" role="alert">
    <span className="list-error-icon" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3h.01" /></svg></span>
    <div><h3>{title}</h3><p>{message}</p></div>
    <button className="patient-primary" type="button" onClick={onRetry}>Try again</button>
  </div>;
}

export function ScheduleActionIcon({ action }: { action: 'add' | 'edit' | 'generate' }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {action === 'add' ? <path d="M12 5v14M5 12h14" /> : action === 'edit' ? <><path d="m15 4 5 5M4 15 16 3a2.1 2.1 0 0 1 5 5L9 20l-6 1 1-6Z" /></> : <><circle cx="6" cy="5" r="2" /><path d="M6 7v8a3 3 0 0 0 3 3h11m-4-4 4 4-4 4" /></>}
  </svg>;
}
