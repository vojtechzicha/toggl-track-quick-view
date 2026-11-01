import { z } from 'zod';
import { getMcpStore } from '../store';
import { defineTool } from '../tool-kit';
import { fmtLocal } from '../time';

export const auditTools = [
  defineTool({
    name: 'list_recent_changes',
    title: 'List recent changes',
    description:
      'The latest writes made through this connector (any connection), newest first, with each entry before and after. ' +
      'Use it to review or undo earlier changes. Reads only the database, never Toggl.',
    access: 'read',
    input: { limit: z.number().int().min(1).max(200).optional().describe('Default 30.') },
    handler: async ({ limit }) =>
      (await getMcpStore().listAudit(limit ?? 30)).map(({ _id, grant_id: _g, at, ...row }) => ({
        id: String(_id),
        at: fmtLocal(new Date(at).getTime()),
        ...row,
      })),
  }),
];
