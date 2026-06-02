'use client';

import { ReactNode } from 'react';

const R = 92;
const C = 2 * Math.PI * R;

export default function ProgressRing({
  fraction,
  color,
  children,
}: {
  fraction: number; // 0..1 (caller clamps for overtime)
  color: string;
  children: ReactNode;
}) {
  const clamped = Math.max(0, Math.min(1, fraction));
  const offset = C * (1 - clamped);

  return (
    <div className="ring-wrap">
      <svg viewBox="0 0 200 200">
        <circle className="ring-track" cx="100" cy="100" r={R} />
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
