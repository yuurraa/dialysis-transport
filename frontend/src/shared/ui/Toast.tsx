import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';


/** A normal append restarts CSS animations, even when React keeps the same node. */
function moveToastRegion(region: HTMLElement, target: HTMLElement) {
  if (region.parentElement === target) return;
  const movable = target as HTMLElement & { moveBefore?: (node: Node, reference: Node | null) => void };
  if (region.isConnected && movable.moveBefore) {
    movable.moveBefore(region, null);
    return;
  }
  // Preserve animation time in browsers without state-preserving DOM moves.
  const wasConnected = region.isConnected;
  const previous = region.getAnimations({ subtree: true }).filter((animation): animation is CSSAnimation => animation instanceof CSSAnimation)
    .map(animation => ({ name: animation.animationName, target: (animation.effect as KeyframeEffect).target,
      time: animation.currentTime, paused: animation.playState === 'paused' }));
  target.appendChild(region);
  if (!wasConnected) return;
  for (const animation of region.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation)) continue;
    const saved = previous.find(item => item.name === animation.animationName && item.target === (animation.effect as KeyframeEffect).target);
    if (saved?.time != null) {
      animation.currentTime = saved.time;
      if (saved.paused) animation.pause();
    } else if (animation.animationName === 'toast-enter') {
      animation.finish(); // An entry animation that had already ended must not replay.
    }
  }
}

/** Move live notifications before a closing dialog hides or disconnects their DOM. */
export function releaseDialogToasts(closing: HTMLDialogElement) {
  const target = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]'))
    .filter(dialog => dialog !== closing && !closing.contains(dialog)).at(-1) ?? document.body;
  closing.querySelectorAll<HTMLElement>(':scope > .toast-region').forEach(region => moveToastRegion(region, target));
}

/** Keep the same notification node above the active modal without restarting its timer. */
export function ToastRegion({ children, announce = false }: { children: ReactNode; announce?: boolean }) {
  const [region] = useState(() => {
    const element = document.createElement('div');
    element.className = 'toast-region';
    return element;
  });
  useLayoutEffect(() => {
    if (announce) {
      region.setAttribute('role', 'status');
      region.setAttribute('aria-live', 'polite');
      region.setAttribute('aria-atomic', 'true');
    }
    const place = () => {
      const dialogs = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
      const target = dialogs.item(dialogs.length - 1) ?? document.body;
      moveToastRegion(region, target);
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] });
    return () => { observer.disconnect(); region.remove(); };
  }, [region, announce]);
  return createPortal(children, region);
}

/** Shared notification appearance and dismissal behavior, including inside native dialogs. */
export function Toast({ message, onDismiss, closing = false, urgent = false }: {
  message: string; onDismiss: () => void; closing?: boolean; urgent?: boolean;
}) {
  const [paused, setPaused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [entered, setEntered] = useState(false);
  const progress = useRef<HTMLSpanElement>(null);
  const elapsed = useRef(0);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const exiting = closing || dismissed;
  useEffect(() => {
    const timer = window.setTimeout(() => setEntered(true), 240);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (paused || exiting) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let previous = performance.now();
    let frame: number;
    const tick = (now: number) => {
      elapsed.current = Math.min(3000, elapsed.current + Math.max(0, now - previous));
      previous = now;
      if (progress.current) progress.current.style.transform = `scaleX(${reduceMotion ? Number(elapsed.current >= 3000) : elapsed.current / 3000})`;
      if (elapsed.current >= 3000) setDismissed(true);
      else frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [paused, exiting]);
  useEffect(() => {
    if (!exiting) return;
    const timer = window.setTimeout(() => dismiss.current(), 180);
    return () => window.clearTimeout(timer);
  }, [exiting]);
  return <div className="auth-toast" role={urgent ? 'alert' : undefined} data-closing={exiting} data-paused={paused} data-entered={entered}
    onMouseEnter={() => setPaused(true)} onMouseLeave={event => setPaused(event.currentTarget.contains(document.activeElement))}
    onFocus={() => setPaused(true)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget)) setPaused(event.currentTarget.matches(':hover'));
    }}>
    <p>{message}</p>
    <button type="button" aria-label="Dismiss notification" onClick={() => setDismissed(true)}>×</button>
    <span ref={progress} className="toast-progress" aria-hidden="true" style={{ transform: 'scaleX(0)' }} />
  </div>;
}
