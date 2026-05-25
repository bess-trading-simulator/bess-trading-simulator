import { useState, useEffect, type MouseEvent } from 'react';
import { Sun, Moon } from 'lucide-react';

const STORAGE_KEY = 'bess-theme';

function applyTheme(dark: boolean) {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  try { localStorage.setItem(STORAGE_KEY, dark ? 'dark' : 'light'); } catch { /* ignore */ }
}

export default function ThemeToggle() {
  const [dark, setDark] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? saved === 'dark' : true;
  });

  // Sync the DOM to the stored preference on mount (the component re-mounts
  // each time the menu opens, so this keeps the attribute correct).
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = (e: MouseEvent) => {
    // The menu popover closes on click and unmounts this button, so apply the
    // theme synchronously here rather than relying on a post-render effect.
    e.stopPropagation();
    setDark((d) => {
      const next = !d;
      applyTheme(next);
      return next;
    });
  };

  return (
    <button
      className="btn btn-icon btn-theme"
      onClick={toggle}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />} {dark ? 'Light mode' : 'Dark mode'}
    </button>
  );
}
