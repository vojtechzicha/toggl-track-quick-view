'use client';

import { ReactNode } from 'react';

const R = 92;
const C = 2 * Math.PI * R;

export default function ProgressRing({
  fraction,
  color,
  projectedFraction,
  scheduledColor,
  children,
}: {
  fraction: number; // 0..1 worked
  color: string;
  projectedFraction?: number; // 0..1 worked + scheduled, drawn as a lighter arc
  scheduledColor?: string;
  children: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const offset = C * (1 - clamped);
  // Scheduled time extends past the worked arc in a lighter color.
  const projected = Math.max(clamped, Math.min(1, projectedFraction ?? 0));
  const projOffset = C * (1 - projected);
  const showScheduled = projected > clamped + 0.0005;

  return (
    <div className="ring-wrap">
      <svg viewBox="0 0 200 200">
        <circle className="ring-track" cx="100" cy="100" r={R} />
        {showScheduled && (
          <circle
            className="ring-fill ring-sched"
            cx="100"
            cy="100"
            r={R}
            stroke={scheduledColor ?? color}
            strokeDasharray={C}
            strokeDashoffset={projOffset}
          />
        )}
        <circle
          className="ring-fill"
          cx="100"
          cy="100"
          r={R}
          stroke={color}
          strokeDasharray={C}
          strokeDashoffset={offset}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}
