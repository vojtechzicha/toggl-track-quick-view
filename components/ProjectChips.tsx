import type { SelectedProject } from './SettingsPanel';

/** Contacts-style initials: first letters of up to two words, or two of one word. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Pick black or white text for legibility on a given hex background. */
function readableInk(hex?: string): string | undefined {
  if (!hex) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  // Perceived luminance, approximate.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#000' : '#fff';
}

/**
 * A row of small colored chips with each project's initials and its full name
 * on hover. Callers show it only when several projects are selected.
 */
export default function ProjectChips({
  projects,
  className = '',
}: {
  projects: SelectedProject[];
  className?: string;
}) {
  if (projects.length === 0) return null;
  return (
    <span className={`proj-chips ${className}`.trim()}>
      {projects.map((p) => (
        <span
          key={p.id}
          className="proj-chip"
          style={p.color ? { background: p.color, color: readableInk(p.color) } : undefined}
          title={p.name}
        >
          {initialsOf(p.name)}
        </span>
      ))}
    </span>
  );
}
