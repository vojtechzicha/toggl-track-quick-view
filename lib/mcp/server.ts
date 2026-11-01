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

const INSTRUCTIONS = `The user's real Toggl Track time entries, behind track.zicha.dev (a timesheet dashboard), through a local copy kept in step with Toggl.
Start with get_context: projects, tags, stored workspaces (timesheet setups) and the time zone. Local times are wall times in that zone; weeks run Saturday to Friday.
A time entry is one tracked span (start, stop, project, tags, description). A timesheet is what a stored workspace bills from the entries: rounded, merged per billing code, capped and balanced by its rules. Write entries; read timesheets.
Writes are saved at once and visible everywhere in the app; they reach Toggl in the background (Toggl's Free plan: about 25 an hour). Never wait or retry for the quota: get_sync_status shows the queue.
Entries not yet in Toggl have negative ids; use them as they are. Re-sending a batch skips entries that already exist.
Verify with get_timesheet: it computes the timesheet exactly as the app does and lists missing billing tags, overlaps and too-long entries.
Only entries not yet in Toggl can be deleted (delete_time_entries); deleting from Toggl is left to the user. Every write is logged; list_recent_changes shows each entry before and after.`;

/** One server per request: the endpoint is stateless and the tool list depends on the token's scopes. */
export function createMcpServer(auth: McpAuth, origin?: string) {
  const server = new McpServer({ name: 'toggl-quick-view', version: '1.0.0' }, { instructions: INSTRUCTIONS });
  registerTools(server, MCP_TOOLS, { auth, origin });
  return server;
}
