import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpAuth } from './oauth';
import { registerTools, type ToolDefinition } from './tool-kit';
import { auditTools } from './tools/audit';
import { contextTools } from './tools/context';
import { entryTools } from './tools/entries';
import { timesheetTools } from './tools/timesheet';

export const MCP_TOOLS: ToolDefinition[] = [
  ...contextTools,
  ...entryTools,
  ...timesheetTools,
  ...auditTools,
];

const INSTRUCTIONS = `Production Toggl Track data behind track.zicha.dev, a timesheet dashboard. Writes go straight to the user's real Toggl account.
Start with get_context: projects, tags, stored workspaces (timesheet setups) and the time zone. Local times are wall times in that zone; weeks run Saturday to Friday.
Toggl's Free plan allows about 30 requests an hour, shared with the dashboard: every create or update is one request. Read once, then work from the result; don't poll.
Writes stop at 5 requests left and say which items to send again later; re-sending a batch skips entries already created.
Verify with get_timesheet: it computes the timesheet exactly as the app does and lists missing billing tags, overlaps and too-long entries.
Nothing here deletes entries; deleting is left to the user in Toggl. Every write is logged; list_recent_changes shows each entry before and after.`;

/** One server per request: the endpoint is stateless and the tool list depends on the token's scopes. */
export function createMcpServer(auth: McpAuth, origin?: string) {
  const server = new McpServer({ name: 'toggl-quick-view', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  registerTools(server, MCP_TOOLS, { auth, origin });
  return server;
}
