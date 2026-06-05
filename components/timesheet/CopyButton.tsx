'use client';

import { useState } from 'react';

/**
 * A small button that copies `text` to the clipboard and briefly confirms.
 * Shared by both timesheet views so a cell's combined description (or an
 * entry's row) can be pasted straight into an external timesheet.
 */
export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked (e.g. insecure context) — silently ignore */
    }
  };
  return (
    <button
      className={`ts-copy ${copied ? 'copied' : ''}`}
      onClick={copy}
      aria-label="Copy description"
      title="Copy description"
    >
      {copied ? '✓' : '⧉'}
    </button>
  );
}
