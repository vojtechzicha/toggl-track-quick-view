// Standalone store: bulk import of Toggl history (the Phase-5 importer).
//
// POST — body: { entries: TogglTimeEntry[], mapping: { key → workspaceNumericId } }
// where a mapping key is a Toggl project id, '0' for entries carrying no
// project, or '*' as the catch-all for any project not otherwise listed
// (archived projects no longer returned by the projects API still appear in
// history). A key that is absent (or mapped to 0) means "skip those entries".
//
// Idempotency is the whole design: every imported entry is stamped with its
// Toggl id, and the sparse unique index on togglId makes a re-run skip what a
// previous (possibly interrupted) run already brought in — it never overwrites,
// so local edits made after an import always win. A Toggl entry still running
// at import time is imported as STOPPED at the time of import (the store's
// one-running-timer invariant belongs to local tracking, not history).

import { NextRequest } from 'next/server';
import { MongoBulkWriteError } from 'mongodb';
import { getStoreDb } from '@/lib/store/mongo';
import { storeGuard, jsonRes, storeError } from '@/lib/store/guard';
import { nextSeqBlock, type EntryDoc, type WorkspaceDoc } from '@/lib/store/model';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One ~90-day window of a single account's entries fits comfortably; the
// client batches larger windows into several calls.
const MAX_ENTRIES = 2000;

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

export async function POST(req: NextRequest) {
  const denied = storeGuard(req);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: 'Malformed JSON body.' }, 400);
  }
  if (!Array.isArray(body.entries)) {
    return jsonRes({ error: 'entries must be an array.' }, 400);
  }
  if (body.entries.length > MAX_ENTRIES) {
    return jsonRes({ error: `Send at most ${MAX_ENTRIES} entries per call.` }, 400);
  }
  if (!body.mapping || typeof body.mapping !== 'object' || Array.isArray(body.mapping)) {
    return jsonRes({ error: 'mapping must be an object of { togglProjectId: workspaceId }.' }, 400);
  }

  // Keep only real assignments; 0 / non-numeric values mean "skip".
  const mapping = new Map<string, number>();
  for (const [key, value] of Object.entries(body.mapping as Record<string, unknown>)) {
    const ws = Number(value);
    if (Number.isInteger(ws) && ws > 0) mapping.set(key, ws);
  }

  try {
    const db = await getStoreDb();

    // Every mapping target must be a real workspace — catching a stale id here
    // beats scattering orphaned entries across the store.
    const targets = [...new Set(mapping.values())];
    if (targets.length > 0) {
      const found = await db
        .collection<WorkspaceDoc>('workspaces')
        .find({ numericId: { $in: targets } })
        .project<{ numericId: number }>({ numericId: 1 })
        .toArray();
      const known = new Set(found.map((w) => w.numericId));
      const missing = targets.filter((id) => !known.has(id));
      if (missing.length > 0) {
        return jsonRes({ error: `Unknown workspace id(s): ${missing.join(', ')}.` }, 400);
      }
    }

    const now = new Date();
    let invalid = 0;
    let unmapped = 0;
    let stoppedRunning = 0;
    const seenTogglIds = new Set<number>();
    const candidates: Omit<EntryDoc, '_id' | 'numericId'>[] = [];

    for (const raw of body.entries) {
      if (!raw || typeof raw !== 'object') {
        invalid++;
        continue;
      }
      const e = raw as Record<string, unknown>;
      const togglId = Number(e.id);
      const start = parseDate(e.start);
      if (!Number.isInteger(togglId) || togglId <= 0 || !start || seenTogglIds.has(togglId)) {
        invalid++;
        continue;
      }
      let stop: Date | null;
      if (e.stop == null) {
        // A running entry becomes history stopped at import time (never before
        // its own start, so the duration stays positive even on a skewed clock).
        stop = now.getTime() > start.getTime() ? now : new Date(start.getTime() + 1000);
        stoppedRunning++;
      } else {
        stop = parseDate(e.stop);
        if (!stop || stop.getTime() < start.getTime()) {
          invalid++;
          continue;
        }
      }
      const key = e.project_id == null ? '0' : String(e.project_id);
      const workspaceId = mapping.get(key) ?? (key === '0' ? undefined : mapping.get('*'));
      if (!workspaceId) {
        unmapped++;
        continue;
      }
      seenTogglIds.add(togglId);
      candidates.push({
        workspaceId,
        description: typeof e.description === 'string' ? e.description.trim() : '',
        start,
        stop,
        // Tags copy verbatim — billing prefixes, "(X)" markers and linked-code
        // tags keep working because the timesheet only ever reads strings.
        tags: Array.isArray(e.tags)
          ? e.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
          : [],
        togglId,
        createdAt: now,
        updatedAt: now,
      });
    }

    const entriesCol = db.collection<EntryDoc>('entries');
    const existing = await entriesCol
      .find({ togglId: { $in: [...seenTogglIds] } })
      .project<{ togglId: number }>({ togglId: 1 })
      .toArray();
    const alreadyImported = new Set(existing.map((d) => d.togglId));
    const fresh = candidates.filter((c) => !alreadyImported.has(c.togglId as number));

    let imported = 0;
    let duplicates = candidates.length - fresh.length;
    if (fresh.length > 0) {
      const firstId = await nextSeqBlock(db, 'entries', fresh.length);
      const docs: EntryDoc[] = fresh.map((c, i) => ({ ...c, numericId: firstId + i }));
      try {
        const res = await entriesCol.insertMany(docs, { ordered: false });
        imported = res.insertedCount;
      } catch (e) {
        // Two runs racing the same window: the unique togglId index rejects the
        // loser's duplicates — count them as skipped, surface anything else.
        if (!(e instanceof MongoBulkWriteError)) throw e;
        const writeErrors = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors];
        if (!writeErrors.every((w) => w?.code === 11000)) throw e;
        imported = e.result?.insertedCount ?? 0;
        duplicates += fresh.length - imported;
      }
    }

    return Response.json({ imported, duplicates, unmapped, invalid, stoppedRunning });
  } catch (e) {
    return storeError(e);
  }
}
