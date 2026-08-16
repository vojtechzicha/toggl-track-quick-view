'use client';

// Topbar quick switch between stored workspaces — the one-click version of
// Settings → Workspaces, which stays the place to create, rename, recapture and
// delete them. Both modes are covered: standalone lists the server's workspace
// documents (with their chip colors), Toggl mode the saved presets.
//
// The menu is a popover under the button on wide screens and a bottom sheet on
// narrow ones (see .ws-switch-menu in globals.css) — on a phone the topbar
// buttons collapse to icons, so a dropdown anchored to a 44px button would be
// both cramped and hard to hit.

import { useEffect, useRef, useState } from 'react';
import type { UseTrackSource } from '@/lib/useTrackSource';

export default function WorkspaceSwitcher({
  t,
  onManage,
}: {
  t: UseTrackSource;
  // Open the Settings panel *on* its Workspaces section — creating, renaming,
  // recapturing and deleting all stay there.
  onManage: () => void;
}) {
  const { workspaceList, activeWorkspace, switchWorkspace } = t;
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Escape closes (returning focus to the button, so keyboard users don't get
  // dropped at the top of the page), as does a click anywhere outside.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('touchstart', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  // Move focus into the menu when it opens — onto the current workspace, so
  // ↑/↓ start from where you are.
  useEffect(() => {
    if (!open) return;
    const el =
      menuRef.current?.querySelector<HTMLButtonElement>('.ws-switch-item.active') ??
      menuRef.current?.querySelector<HTMLButtonElement>('.ws-switch-item');
    el?.focus();
  }, [open]);

  // Nothing stored yet: there is nothing to switch between, and Settings is
  // where the first workspace gets created. Keeps the topbar clean for anyone
  // who never saved one.
  if (workspaceList.length === 0) return null;

  const activeEntry = workspaceList.find((w) => w.id === activeWorkspace?.id) ?? null;

  const onItemKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLButtonElement>('.ws-switch-item') ?? []),
    ];
    const i = items.indexOf(e.currentTarget);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length];
    next?.focus();
  };

  const choose = (id: string) => {
    setOpen(false);
    // Recalling the workspace already on screen would be a no-op write; skip it
    // so a stray click can't bump the sync revision.
    if (id !== activeWorkspace?.id) switchWorkspace(id);
    btnRef.current?.focus();
  };

  return (
    <div className="ws-switch">
      <button
        ref={btnRef}
        type="button"
        className={`navbtn ws-switch-btn${open ? ' open' : ''}`}
        aria-label="Switch workspace"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {activeEntry?.color ? (
          <span className="proj-swatch ws-switch-swatch" style={{ background: activeEntry.color }} />
        ) : (
          <span className="navbtn-icon">🗂</span>
        )}
        <span className="navbtn-text ws-switch-name">{activeWorkspace?.name ?? 'Workspace'}</span>
        <span className="ws-switch-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <>
          <div className="ws-switch-backdrop" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="ws-switch-menu" ref={menuRef} role="menu" aria-label="Workspaces">
            <div className="ws-switch-head">Workspace</div>
            {!activeWorkspace && (
              <p className="ws-switch-note">
                The current settings don&apos;t match a stored workspace — picking one replaces
                them.
              </p>
            )}
            <div className="ws-switch-list">
              {workspaceList.map((w) => {
                const active = w.id === activeWorkspace?.id;
                return (
                  <button
                    key={w.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`ws-switch-item${active ? ' active' : ''}`}
                    onClick={() => choose(w.id)}
                    onKeyDown={onItemKeyDown}
                  >
                    <span
                      className="proj-swatch ws-switch-swatch"
                      style={{ background: w.color ?? 'var(--line)' }}
                    />
                    <span className="ws-switch-item-name">{w.name}</span>
                    {active && (
                      <span className="ws-switch-check" aria-hidden="true">
                        ✓
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              role="menuitem"
              className="ws-switch-manage"
              onClick={() => {
                setOpen(false);
                onManage();
              }}
            >
              ⚙ Manage workspaces…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
