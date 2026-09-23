'use client';

// Error toast for failed store mutations. Dismisses after 6s or on click.

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
