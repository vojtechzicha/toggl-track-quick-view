'use client';

import { useEffect, useRef, useState } from 'react';
import {
  presetMatches,
  type SettingsPreset,
  type SettingsValue,
} from '@/components/SettingsPanel';

/**
 * The topbar quick-switch: a button that drops down the stored workspaces and
 * recalls one on click. The currently-matching workspace (if any) is named on
 * the button and ticked in the menu. Renders nothing when no workspace is stored,
 * so it stays out of the way until the user opts into the feature.
 */
export default function WorkspaceSwitcher({
  presets,
  current,
  onSelect,
}: {
  presets: SettingsPreset[];
  current: SettingsValue;
  onSelect: (preset: SettingsPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (presets.length === 0) return null;
  const active = presets.find((p) => presetMatches(p.value, current)) ?? null;

  return (
    <div className="ws-switcher" ref={ref}>
      <button
        className="navbtn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Workspaces"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="navbtn-icon">🗂</span>
        <span className="navbtn-text">{active ? active.name : 'Workspaces'}</span>
      </button>
      {open && (
        <div className="ws-menu" role="menu">
          {presets.map((p) => {
            const isActive = p === active;
            return (
              <button
                key={p.id}
                role="menuitem"
                className={`ws-menu-item${isActive ? ' active' : ''}`}
                onClick={() => {
                  onSelect(p);
                  setOpen(false);
                }}
              >
                <span className="ws-menu-check">{isActive ? '✓' : ''}</span>
                <span className="ws-menu-name">{p.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
