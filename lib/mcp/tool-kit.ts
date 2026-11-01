// Every MCP tool is a zod input shape plus a handler. Read tools need
// timesheet:read, writes timesheet:write; tools the token can't use are not
// even listed. Same shape as zicha-study and szz-flashcards.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z, ZodRawShape } from 'zod';
import { TogglError } from '@/lib/toggl/server';
import { MCP_SCOPES, type McpAuth } from './oauth';
import { getMcpStore } from './store';

export type ToolAccess = 'read' | 'write';

export interface ToolContext {
  auth: McpAuth;
  /** Public origin of the request (e.g. https://track.zicha.dev), for links in results. */
  origin?: string;
}

export interface ToolDefinition<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  access: ToolAccess;
  input: Shape;
  handler: (args: z.objectOutputType<Shape, z.ZodTypeAny>, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<Shape extends ZodRawShape>(def: ToolDefinition<Shape>): ToolDefinition {
  return def as unknown as ToolDefinition;
}

/** Expected failures (not found, validation). The message is shown to the agent. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function canUse(def: ToolDefinition, scopes: string[]): boolean {
  return def.access === 'read' ? scopes.includes(MCP_SCOPES.READ) : scopes.includes(MCP_SCOPES.WRITE);
}

function textResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data ?? null, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

export async function runTool(def: ToolDefinition, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
  if (!canUse(def, ctx.auth.scopes)) {
    return errorResult(`This connection is read-only; ${def.name} needs the ${MCP_SCOPES.WRITE} scope.`);
  }
  try {
    return textResult(await def.handler(args as never, ctx));
  } catch (err: unknown) {
    if (err instanceof ToolError) return errorResult(err.message);
    if (err instanceof TogglError) {
      return errorResult(
        err.resetsInSec !== null
          ? `${err.message} Toggl's quota resets in ${Math.ceil(err.resetsInSec / 60)} min.`
          : err.message
      );
    }
    console.error(`MCP tool ${def.name} failed:`, err);
    return errorResult(err instanceof Error ? err.message : 'Unknown error.');
  }
}

export function registerTools(server: McpServer, tools: ToolDefinition[], ctx: ToolContext) {
  for (const def of tools) {
    if (!canUse(def, ctx.auth.scopes)) continue;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input,
        annotations: {
          title: def.title,
          readOnlyHint: def.access === 'read',
          // Writes change entries in place; nothing here deletes.
          destructiveHint: false,
          // Toggl is an external system the tools reach.
          openWorldHint: true,
        },
      },
      ((args: unknown) => runTool(def, args, ctx)) as never
    );
  }
}

// ─── Audit log ──────────────────────────────────────────────────────────────

export async function audit(
  ctx: ToolContext,
  entry: { tool: string; action: 'create' | 'update'; entryId: number | null; before?: unknown; after?: unknown }
) {
  await getMcpStore().insertAudit({
    tool: entry.tool,
    action: entry.action,
    entry_id: entry.entryId,
    before: entry.before ?? null,
    after: entry.after ?? null,
    grant_id: ctx.auth.grantId,
    client_name: ctx.auth.clientName,
  });
}
