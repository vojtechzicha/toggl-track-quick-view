'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ManualInstallGuide } from '@/lib/pwa';

/**
 * Manual install walkthrough for browsers with no install prompt (see
 * `manualInstallGuide` in lib/pwa.ts). It opens from inside the settings
 * panel, so it is portaled to body to escape the panel's scroll box.
 *
 * Each step shows the control to look for as a "menu chip" (share glyph,
 * "Add to Home Screen" row, Add button) to match against the real menu.
 */
interface Step {
  text: string;
  chip?: React.ReactNode;
  hint?: string;
}

const IOS_STEPS: Step[] = [
  {
    text: 'Tap the Share button',
    chip: <MenuChip icon={<ShareGlyph />} />,
    hint: 'the square with an arrow in your browser toolbar',
  },
  {
    text: 'Scroll down the menu and choose',
    chip: <MenuChip icon={<PlusSquareGlyph />} label="Add to Home Screen" />,
  },
  { text: 'Confirm in the top right with', chip: <MenuChip label="Add" accent /> },
];

const STEPS: Record<ManualInstallGuide, Step[]> = {
  ios: IOS_STEPS,
  // Old third-party or in-app browser: switch to Safari first
  'ios-safari-needed': [
    {
      text: 'Open this page in Safari',
      chip: <MenuChip icon={<CompassGlyph />} label="Safari" />,
      hint: "This browser can't add it to the home screen. Safari can.",
    },
    ...IOS_STEPS,
  ],
  'mac-safari': [
    {
      text: 'Open the File menu and choose',
      chip: <MenuChip icon={<DockGlyph />} label="Add to Dock" />,
    },
    { text: 'Confirm with', chip: <MenuChip label="Add" accent /> },
  ],
};

export default function InstallGuideSheet({
  guide,
  appName,
  onClose,
}: {
  guide: ManualInstallGuide;
  appName: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes. Focus moves to the close button and returns to the opener.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  const steps = STEPS[guide];
  const mac = guide === 'mac-safari';

  return createPortal(
    <div
      className="overlay install-guide"
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-guide-title"
      onClick={onClose}
    >
      <div className="panel install-guide-panel" onClick={(e) => e.stopPropagation()}>
        <div className="install-guide-head">
          <img src="/icons/icon-192.png" alt="" width={56} height={56} className="install-guide-icon" />
          <div>
            <h2 id="install-guide-title">{appName} as an app</h2>
            <p className="hint">
              {mac
                ? 'Add this site to your Dock to open it in its own window.'
                : 'Add this site to your home screen to open it full screen, like an app.'}
            </p>
          </div>
        </div>

        <ol className="install-steps">
          {steps.map((step, i) => (
            <li key={i} className="install-step">
              <span aria-hidden className="install-step-num">
                {i + 1}
              </span>
              <span className="install-step-body">
                {step.text}
                {step.chip && <> {step.chip}</>}
                {step.hint && <span className="install-step-hint">{step.hint}</span>}
              </span>
            </li>
          ))}
        </ol>

        <p className="hint">
          {mac
            ? 'Needs Safari on macOS Sonoma or later.'
            : 'No App Store needed.'}
        </p>

        <div className="row">
          <button ref={closeRef} type="button" className="btn btn-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

/** A system menu row: glyph, label, or both. */
function MenuChip({
  icon,
  label,
  accent,
}: {
  icon?: React.ReactNode;
  label?: string;
  /** Blue, like the system's confirming "Add" button. */
  accent?: boolean;
}) {
  return (
    <span className={`menu-chip${accent ? ' accent' : ''}`}>
      {icon && (
        <span aria-hidden className="menu-chip-icon">
          {icon}
        </span>
      )}
      {label}
    </span>
  );
}

// Inline glyphs; the app has no icon library.
const GLYPH = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.25,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function ShareGlyph() {
  return (
    <svg {...GLYPH}>
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function PlusSquareGlyph() {
  return (
    <svg {...GLYPH}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 12h8" />
      <path d="M12 8v8" />
    </svg>
  );
}

function CompassGlyph() {
  return (
    <svg {...GLYPH}>
      <circle cx="12" cy="12" r="10" />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
    </svg>
  );
}

function DockGlyph() {
  return (
    <svg {...GLYPH}>
      <path d="M2 8h20" />
      <rect width="20" height="16" x="2" y="4" rx="2" />
      <path d="M6 16h12" />
    </svg>
  );
}
