import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const preferenceKey = 'dialysis-colour-theme';
const validTheme = (value: string | null | undefined): Theme => value === 'dark' ? 'dark' : 'light';

/** Shares the pre-paint preference with the public and authenticated headers. */
export default function ThemeControl() {
  const [theme, setTheme] = useState<Theme>(() => validTheme(document.documentElement.dataset.theme));
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#1C1A18' : '#F6F4EE');
    const sync = (event: StorageEvent) => {
      if (event.key === preferenceKey || event.key === null) setTheme(validTheme(event.newValue));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [theme]);

  return <button type="button" className="theme-control" aria-label="Colour theme" aria-pressed={theme === 'dark'} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`} onClick={() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem(preferenceKey, next); } catch { /* A visual preference must work without storage. */ }
  }}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="M12 4v16a8 8 0 0 0 0-16" fill="currentColor" stroke="none" /></svg>
  </button>;
}
