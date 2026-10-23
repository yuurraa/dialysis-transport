import { useState } from 'react';

/** Shared notification appearance and dismissal behavior, including inside native dialogs. */
export function Toast({ message, onDismiss, closing = false, urgent = false }: {
  message: string; onDismiss: () => void; closing?: boolean; urgent?: boolean;
}) {
  const [paused, setPaused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  return <div className="auth-toast" role={urgent ? 'alert' : undefined} data-closing={closing || dismissed} data-paused={paused}
    onAnimationEnd={event => {
      if (event.target === event.currentTarget && event.animationName === 'toast-exit') onDismiss();
    }} onMouseEnter={() => setPaused(true)} onMouseLeave={event => setPaused(event.currentTarget.contains(document.activeElement))}
    onFocus={() => setPaused(true)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setPaused(event.currentTarget.matches(':hover'));
    }}>
    <p>{message}</p>
    <button type="button" aria-label="Dismiss notification" onClick={() => setDismissed(true)}>×</button>
    <span className="toast-progress" aria-hidden="true" onAnimationEnd={() => setDismissed(true)} />
  </div>;
}
