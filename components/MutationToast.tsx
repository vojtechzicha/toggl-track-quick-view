'use client';

// Transient error toast for failed standalone-store mutations (entry edits on
// the tracker, workspace CRUD in Settings on any page). Renders nothing while
// there's no error; auto-dismisses after a few seconds, or on click.

import { useEffect } from 'react';
import type { UseTrackSource } from '@/lib/useTrackSource';

export default function MutationToast({ t }: { t: UseTrackSource }) {
  const { mutationError, clearMutationError } = t;

  useEffect(() => {
    if (!mutationError) return;
    const id = setTimeout(clearMutationError, 6000);
    return () => clearTimeout(id);
  }, [mutationError, clearMutationError]);

  if (!mutationError) return null;
  return (
    <div className="toast err" role="alert" onClick={clearMutationError}>
      {mutationError}
    </div>
  );
}
