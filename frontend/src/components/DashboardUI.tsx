import { useId, useLayoutEffect, useRef, type FormEventHandler, type ReactNode, type Ref } from 'react';

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
  title: string; description?: ReactNode; children: ReactNode; footer: ReactNode;
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
  const content = <><div className="overlay-body">{children}</div>{error && <div className="overlay-toast-region"><div className="auth-toast error-toast" role="alert"><p>{error}</p><button type="button" aria-label="Dismiss error" onClick={onDismissError}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div></div>}<footer className="overlay-footer patient-actions">{footer}</footer></>;
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
    <header className="overlay-header"><div><h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2>{description && <p id={descriptionId} className="page-description">{description}</p>}</div>
      <button className="overlay-close" type="button" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </header>
    {onSubmit ? <form className="overlay-content patient-form" onSubmit={onSubmit} noValidate={noValidate}>{content}</form> : <div className="overlay-content">{content}</div>}
  </dialog>;
}
