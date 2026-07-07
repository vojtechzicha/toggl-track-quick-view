// Standalone store: tag autocomplete for the tracker's billing-tag combobox.
//
// GET ?q=&prefix= — distinct tags ordered by recency (max entry start), newest
// first, limit 20. `prefix` narrows to tags starting with the billing prefix
// (case-sensitive, like billingTagOf); `q` is the user's typed text, matched
// case-insensitively anywhere in the tag.

import { NextRequest } from 'next/server';
import { getStoreDb } from '@/lib/store/mongo';
import { storeGuard, jsonRes, storeError } from '@/lib/store/guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function GET(req: NextRequest) {
  const denied = storeGuard(req);
  if (denied) return denied;

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  const prefix = req.nextUrl.searchParams.get('prefix')?.trim() ?? '';

  const conditions: Record<string, unknown>[] = [];
  if (prefix) conditions.push({ tag: { $regex: `^${escapeRegex(prefix)}` } });
  if (q) conditions.push({ tag: { $regex: escapeRegex(q), $options: 'i' } });

  try {
    const db = await getStoreDb();
    const rows = await db
      .collection('entries')
      .aggregate<{ _id: string }>([
        { $match: { tags: { $exists: true, $ne: [] } } },
        { $unwind: '$tags' },
        { $project: { tag: '$tags', start: 1 } },
        ...(conditions.length ? [{ $match: { $and: conditions } }] : []),
        { $group: { _id: '$tag', last: { $max: '$start' } } },
        { $sort: { last: -1 } },
        { $limit: 20 },
      ])
      .toArray();
    return Response.json(rows.map((r) => r._id));
  } catch (e) {
    return storeError(e);
  }
}
