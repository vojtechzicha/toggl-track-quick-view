'use client';

import { useState } from 'react';

/** Copies `text` to the clipboard and briefly shows a check mark. */
export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable (e.g. insecure context) */
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
