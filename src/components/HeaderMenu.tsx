import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Menu, X } from 'lucide-react';

interface Props {
  children: ReactNode;
}

export default function HeaderMenu({ children }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="header-menu" ref={ref}>
      <button
        className="header-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        aria-label="Menu"
        aria-expanded={open}
      >
        {open ? <X size={18} strokeWidth={2.75} /> : <Menu size={18} strokeWidth={2.75} />}
      </button>
      {open && (
        <div className="header-menu-pop" onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  );
}
