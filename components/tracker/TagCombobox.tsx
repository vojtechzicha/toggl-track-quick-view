'use client';

// Billing-tag combobox: a free-text input with recency-ordered suggestions from
// the store (GET /api/store/tags). Prefix-aware — suggestions are limited to
// tags carrying the workspace's billing prefix; free text creates a new tag.
// Enter accepts, Esc dismisses, arrows navigate; blur commits the typed text.

import { useEffect, useRef, useState } from 'react';
import { suggestTagsApi } from '@/lib/source/standalone';

export default function TagCombobox({
  value,
  prefix,
  onCommit,
  placeholder,
  autoFocus = false,
  onClose,
}: {
  /** The current billing tag, or null when the entry has none. */
  value: string | null;
  /** The workspace's billing-tag prefix (narrows suggestions). */
  prefix: string;
  /** Called with the accepted tag (trimmed) or null when cleared. */
  onCommit: (tag: string | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
  /** Popover use: called after a commit or Esc so the opener can close it. */
  onClose?: () => void;
}) {
  const [text, setText] = useState(value ?? '');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const committedRef = useRef(false);

  // Keep the field in sync when the entry's tag changes underneath (e.g. the
  // poll reconciled a canonical value) while the user isn't mid-edit.
  useEffect(() => {
    if (!open) setText(value ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Debounced suggestion fetch; also fires on focus with the empty query so the
  // most recent tags appear before any typing.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      suggestTagsApi(text.trim(), prefix)
        .then((tags) => {
          setItems(tags);
          setActive(-1);
        })
        .catch(() => setItems([]));
    }, 150);
    return () => clearTimeout(id);
  }, [open, text, prefix]);

  const commit = (raw: string | null) => {
    committedRef.current = true;
    const tag = raw?.trim() || null;
    if (tag !== (value ?? null)) onCommit(tag);
    setOpen(false);
    onClose?.();
  };

  return (
    <div className="tagbox" ref={wrapRef}>
      <input
        type="text"
        value={text}
        placeholder={placeholder ?? `${prefix}123`}
        autoFocus={autoFocus}
        onFocus={() => {
          committedRef.current = false;
          setOpen(true);
        }}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, -1));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            commit(active >= 0 ? items[active] : text);
          } else if (e.key === 'Escape') {
            committedRef.current = true; // discard, don't commit on the blur that follows
            setText(value ?? '');
            setOpen(false);
            onClose?.();
          }
        }}
        onBlur={() => {
          // Give a click on a suggestion time to land first (mousedown commits).
          setTimeout(() => {
            if (!committedRef.current && open) commit(text);
          }, 0);
        }}
      />
      {open && items.length > 0 && (
        <ul className="tagbox-list" role="listbox">
          {items.map((tag, i) => (
            <li key={tag}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                className={`tagbox-item${i === active ? ' active' : ''}`}
                // mousedown, not click: it must beat the input's blur handler.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(tag);
                }}
              >
                {tag}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
