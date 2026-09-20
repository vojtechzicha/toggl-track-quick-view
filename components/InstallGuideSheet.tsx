'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ManualInstallGuide } from '@/lib/pwa';

/**
 * The manual-install walkthrough behind the Settings "Install as an app"
 * button where the browser has no install prompt to trigger (see
 * `manualInstallGuide` in lib/pwa.ts). Reuses the settings overlay + panel
 * shell, one level above it (the button lives inside the settings panel), and
 * is portaled to body so the panel's own scroll box can't clip it.
 *
 * Each step names the control the person has to find and shows it as a "menu
 * chip" — the iOS share glyph, the Add-to-Home-Screen row, the Add button —
 * so the sheet can be matched against the real share sheet at a glance rather
 * than read.
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
  // The browser in hand cannot do it (old third-party browser or an in-app
  // one), so Safari comes first and the rest is the same
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

  // Escape + focus: the sheet is short, so focus lands on the one button and
  // returns to the opener afterwards. No scroll lock — body is overflow:hidden
  // already (globals.css) and the settings panel below scrolls on its own.
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
          {/* the real app icon, so what lands on the home screen is recognisable */}
          <img src="/icons/icon-192.png" alt="" width={56} height={56} className="install-guide-icon" />
          <div>
            <h2 id="install-guide-title">{appName} as an app</h2>
            <p className="hint">
              {mac
                ? 'Add this site to your Dock. It then opens in its own window, like an app.'
                : 'Add this site to your home screen. It then opens like an app, full screen.'}
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
            ? 'The icon in your Dock opens this site as an app, without going through the App Store. The menu item is there in Safari on macOS Sonoma and later.'
            : 'The icon on your home screen opens this site as an app, without going through the App Store.'}
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

/** A system menu row as the person will see it: glyph, label, or both. */
function MenuChip({
  icon,
  label,
  accent,
}: {
  icon?: React.ReactNode;
  label?: string;
  /** the confirming "Add" button, blue like the real one */
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

// Inline glyphs (no icon library in this app): the iOS share box, the
// "add to home screen" plus square, Safari's compass and the macOS Dock.
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
