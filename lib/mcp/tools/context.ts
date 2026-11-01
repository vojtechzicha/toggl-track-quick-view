// Orientation: the Toggl account, projects, tags, stored workspaces and quota.

import { z } from 'zod';
import { getAccount, quotaStatus, QUOTA_RESERVE } from '@/lib/toggl/server';
import { readSyncPayload } from '@/lib/sync/server';
import { appTimeZone, fmtLocal } from '../time';
import { defineTool } from '../tool-kit';
import { describeWorkspace, workspacesOf } from '../timesheet';

const getContext = defineTool({
  name: 'get_context',
  title: 'Get context',
  description:
    'Start here. The Toggl account and default workspace, its projects and tags, the stored workspaces ' +
    '(timesheet setups: projects, billing tag prefix, rounding, weekly hours, overtime and balancing rules), ' +
    'the time zone used for every local time, and the last known Toggl quota. Account data is cached for a day; ' +
    'refresh: true re-reads it from Toggl (one request), e.g. after creating a project or tag in Toggl.',
  access: 'read',
  input: { refresh: z.boolean().optional() },
  handler: async ({ refresh }) => {
    const [{ value: account, atMs }, payload, quota] = await Promise.all([
      getAccount({ refresh: !!refresh }),
      readSyncPayload(),
      quotaStatus(),
    ]);
    const { presets, active } = workspacesOf(payload);
    return {
      time_zone: appTimeZone(),
      week: 'Weeks run Saturday to Friday, as on the dashboard and timesheet.',
      account: { name: account.fullname, workspace_id: account.workspaceId, cached_at: fmtLocal(atMs) },
      projects: account.projects.map((p) => ({ id: p.id, name: p.name, ...(p.active ? {} : { archived: true }) })),
      tags: account.tags.map((t) => t.name),
      workspaces: presets.map((p) => describeWorkspace({ id: p.id, name: p.name, value: p.value })),
      active_workspace: active ? (active.id ?? active.name) : null,
      quota: {
        note:
          `Free plan: 30 requests/hour per bucket, shared with the dashboard. Queued writes are sent until ${QUOTA_RESERVE} are left; ` +
          'tool calls never wait for it. Figures are what Toggl reported on its last response.',
        buckets: quota.map((q) => ({
          bucket: q.bucket,
          remaining: q.remaining,
          resets_in_minutes: Math.ceil((q.resetsAtMs - Date.now()) / 60000),
          reported_at: fmtLocal(q.atMs),
        })),
      },
    };
  },
});

export const contextTools = [getContext];
