// Checks for the Claude connector (`pnpm check:mcp`). No network, no database:
// the OAuth flow runs against the in-memory store, and the time-entry and
// timesheet helpers are pure.
//
//  - OAuth: registration rules, PKCE, single-use codes, refresh rotation (a
//    reused refresh token revokes the connection), scope narrowing, and that
//    rotating APP_PASSWORD disconnects every grant.
//  - Local times in APP_TIME_ZONE, across both DST changes.
//  - Tag and project resolution, and batch planning: validation, duplicates
//    (what makes re-sending a batch safe) and overlaps.
//  - The server-built timesheet matches the export builder and flags what the
//    Timesheet page flags.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { installResolveHooks } from './resolve-hooks.mjs';

installResolveHooks();
process.env.TZ = 'Europe/Prague';
process.env.APP_PASSWORD = 'correct horse battery staple';

const oauth = await import('../lib/mcp/oauth.ts');
const { memoryStore, setMcpStoreForChecks } = await import('../lib/mcp/store.ts');
const time = await import('../lib/mcp/time.ts');
const entries = await import('../lib/mcp/entries.ts');
const timesheet = await import('../lib/mcp/timesheet.ts');
const { buildExportDoc } = await import('../lib/export/model.ts');
const { EMPTY_EXPORT_FIELDS } = await import('../lib/exportFields.ts');
const { applyUpdate } = await import('../lib/mcp/tools/entries.ts');

let checks = 0;
const ok = (cond: unknown, msg: string) => {
  checks++;
  assert.ok(cond, msg);
};
const eq = (a: unknown, b: unknown, msg: string) => {
  checks++;
  assert.deepStrictEqual(a, b, msg);
};
async function rejects(p: Promise<unknown>, code: string, msg: string) {
  checks++;
  await assert.rejects(p, (e: unknown) => e instanceof oauth.OAuthError && e.code === code, msg);
}

// ─── OAuth ──────────────────────────────────────────────────────────────────

const ORIGIN = 'https://track.example';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
};

async function connect(scope = 'timesheet:read timesheet:write', grantedWrite = true) {
  const client = await oauth.registerClient({
    client_name: 'Claude',
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
  });
  const { verifier, challenge } = pkce();
  const v = await oauth.validateAuthorizeRequest(
    {
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope,
      state: 'xyz',
    },
    ORIGIN
  );
  assert.ok(v.ok, 'authorize request is valid');
  const scopes = grantedWrite ? v.request.scopes : v.request.scopes.filter((s) => s === oauth.MCP_SCOPES.READ);
  const code = await oauth.issueAuthorizationCode(v.request, scopes);
  const clientRow = { _id: client.client_id, token_endpoint_auth_method: 'none' };
  const tokens = await oauth.exchangeAuthorizationCode(
    new URLSearchParams({ code, code_verifier: verifier, redirect_uri: REDIRECT }),
    clientRow,
    ORIGIN
  );
  return { client, clientRow, code, verifier, tokens };
}

setMcpStoreForChecks(memoryStore());
{
  // Registration only accepts Claude's callbacks and loopback.
  await rejects(
    oauth.registerClient({ redirect_uris: ['https://evil.example/cb'] }),
    'invalid_redirect_uri',
    'foreign redirect refused'
  );
  const loop = await oauth.registerClient({
    redirect_uris: ['http://localhost:51234/callback'],
    token_endpoint_auth_method: 'none',
  });
  ok(loop.client_id && !('client_secret' in loop), 'loopback public client registers without a secret');
  const conf = await oauth.registerClient({ redirect_uris: [REDIRECT] });
  ok(typeof conf.client_secret === 'string', 'confidential client gets a secret');

  // A full connection.
  const { clientRow, code, verifier, tokens } = await connect();
  eq(tokens.scope, 'timesheet:read timesheet:write', 'both scopes granted');
  const auth = await oauth.verifyAccessToken(tokens.access_token, ORIGIN);
  ok(auth && auth.clientName === 'Claude', 'access token verifies');
  ok((await oauth.verifyAccessToken(tokens.access_token, 'https://preview.example')) === null, 'token bound to its origin');

  // Codes are single use.
  await rejects(
    oauth.exchangeAuthorizationCode(new URLSearchParams({ code, code_verifier: verifier }), clientRow, ORIGIN),
    'invalid_grant',
    'code reuse refused'
  );

  // Refresh rotates; reusing the old refresh token revokes the grant.
  const next = await oauth.refreshAccessToken(new URLSearchParams({ refresh_token: tokens.refresh_token }), clientRow);
  ok(next.refresh_token !== tokens.refresh_token, 'refresh rotates');
  ok(await oauth.verifyAccessToken(next.access_token, ORIGIN), 'new access token works');
  await rejects(
    oauth.refreshAccessToken(new URLSearchParams({ refresh_token: tokens.refresh_token }), clientRow),
    'invalid_grant',
    'old refresh token refused'
  );
  ok((await oauth.verifyAccessToken(next.access_token, ORIGIN)) === null, 'reuse revoked the whole grant');

  // A refresh can narrow scopes, not widen them.
  const readOnly = await connect('timesheet:read timesheet:write', false);
  eq(readOnly.tokens.scope, 'timesheet:read', 'read-only consent');
  await rejects(
    oauth.refreshAccessToken(
      new URLSearchParams({ refresh_token: readOnly.tokens.refresh_token, scope: 'timesheet:write' }),
      readOnly.clientRow
    ),
    'invalid_scope',
    'refresh cannot add write'
  );

  // PKCE is required and checked.
  const bad = await oauth.registerClient({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
  const v = await oauth.validateAuthorizeRequest(
    { client_id: bad.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge_method: 'S256' },
    ORIGIN
  );
  ok(!v.ok && v.redirectTo?.includes('error=invalid_request'), 'missing PKCE challenge redirects with an error');
  const p = pkce();
  const v2 = await oauth.validateAuthorizeRequest(
    {
      client_id: bad.client_id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
    },
    ORIGIN
  );
  assert.ok(v2.ok);
  const c2 = await oauth.issueAuthorizationCode(v2.request, v2.request.scopes);
  await rejects(
    oauth.exchangeAuthorizationCode(
      new URLSearchParams({ code: c2, code_verifier: pkce().verifier }),
      { _id: bad.client_id, token_endpoint_auth_method: 'none' },
      ORIGIN
    ),
    'invalid_grant',
    'wrong PKCE verifier refused'
  );

  // A code approved before a password rotation is refused afterwards.
  {
    const c = await oauth.registerClient({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
    const p = pkce();
    const v = await oauth.validateAuthorizeRequest(
      { client_id: c.client_id, redirect_uri: REDIRECT, response_type: 'code', code_challenge: p.challenge, code_challenge_method: 'S256' },
      ORIGIN
    );
    assert.ok(v.ok);
    const code = await oauth.issueAuthorizationCode(v.request, v.request.scopes);
    const saved = process.env.APP_PASSWORD;
    process.env.APP_PASSWORD = 'rotated between consent and exchange';
    await rejects(
      oauth.exchangeAuthorizationCode(
        new URLSearchParams({ code, code_verifier: p.verifier }),
        { _id: c.client_id, token_endpoint_auth_method: 'none' },
        ORIGIN
      ),
      'invalid_grant',
      'code from before a rotation refused'
    );
    process.env.APP_PASSWORD = saved;
  }

  // Rotating APP_PASSWORD disconnects every grant.
  const live = await connect();
  ok(await oauth.verifyAccessToken(live.tokens.access_token, ORIGIN), 'live before rotation');
  process.env.APP_PASSWORD = 'a different long password';
  ok((await oauth.verifyAccessToken(live.tokens.access_token, ORIGIN)) === null, 'rotation ends access');
  await rejects(
    oauth.refreshAccessToken(new URLSearchParams({ refresh_token: live.tokens.refresh_token }), live.clientRow),
    'invalid_grant',
    'rotation ends refresh'
  );
}
setMcpStoreForChecks(null);

// ─── Local time (Europe/Prague) ─────────────────────────────────────────────

{
  eq(time.parseInstant('2026-10-30T09:15'), Date.parse('2026-10-30T08:15:00Z'), 'CET wall time');
  eq(time.parseInstant('2026-07-01 09:15'), Date.parse('2026-07-01T07:15:00Z'), 'CEST wall time, space separator');
  eq(time.parseInstant('2026-07-01T09:15:00+02:00'), Date.parse('2026-07-01T07:15:00Z'), 'ISO offset kept');
  eq(time.parseInstant('2026-03-29T02:30'), null, 'wall time skipped by the spring DST jump is refused');
  eq(time.parseInstant('2026-02-30T09:00'), null, 'impossible date refused');
  eq(time.parseInstant('9:00'), null, 'bare clock refused');
  eq(time.fmtLocal(Date.parse('2026-10-25T00:30:00Z')), '2026-10-25T02:30', 'formats in local time');
  const r = time.dateRange('2026-10-24', '2026-10-25');
  eq((r.toMs - r.fromMs) / 3600000, 49, 'a range over the autumn change is 49 hours');
  eq(time.fmtDate(time.weekStartOf(Date.parse('2026-10-30T12:00:00Z'))), '2026-10-24', 'weeks start on Saturday');
}

// ─── Resolution and planning ────────────────────────────────────────────────

const account = {
  fullname: 'Test Person',
  workspaceId: 1,
  projects: [
    { id: 10, name: 'Alpha', active: true },
    { id: 11, name: 'Beta', active: true },
    { id: 12, name: 'Old', active: false },
  ],
  tags: [
    { id: 1, name: 'D-100' },
    { id: 2, name: 'D-200 Phase two' },
    { id: 3, name: 'D-300 a' },
    { id: 4, name: 'D-300 b' },
    { id: 5, name: '.Time Off' },
  ],
};

{
  const tag = (s: string) => entries.resolveTag(account, s);
  eq(tag('D-100'), { ok: true, value: 'D-100' }, 'exact tag');
  eq(tag('d-100'), { ok: true, value: 'D-100' }, 'case-insensitive tag');
  eq(tag('D-200'), { ok: true, value: 'D-200 Phase two' }, 'tag by its first word');
  ok(!tag('D-300').ok && /ambiguous/.test((tag('D-300') as { error: string }).error), 'ambiguous first word refused');
  ok(!tag('D-999').ok, 'unknown tag refused');
  const withNew = entries.resolveTags(account, ['D-100', 'D-999'], true);
  eq(withNew, { tags: ['D-100', 'D-999'], created: ['D-999'], errors: [] }, 'new tags pass through when allowed');

  eq(entries.resolveProject(account, 'beta'), { ok: true, value: account.projects[1] }, 'project by name');
  eq(entries.resolveProject(account, '10'), { ok: true, value: account.projects[0] }, 'project by id string');
  ok(!entries.resolveProject(account, 'Old').ok, 'archived project refused for writes');
}

{
  const existing = [
    {
      id: 500,
      start: '2026-10-29T08:00:00Z',
      stop: '2026-10-29T10:00:00Z',
      duration: 7200,
      project_id: 10,
      workspace_id: 1,
      description: 'Review',
      tags: ['D-100'],
    },
  ];
  const now = Date.parse('2026-11-01T12:00:00Z');
  const plan = entries.planEntries(
    [
      // The entry above again (09:00 local = 08:00Z): a duplicate.
      { start: '2026-10-29T09:00', stop: '2026-10-29T11:00', description: 'Review', project: 'Alpha', tags: ['D-100'] },
      // Overlaps the existing one and the next item.
      { start: '2026-10-29T10:30', duration_minutes: 90, description: 'Design', project: 'Alpha', tags: ['D-200'] },
      { start: '2026-10-29T11:30', stop: '2026-10-29T12:00', description: 'Call', project: 'Beta' },
    ],
    account,
    existing,
    { allowNewTags: false, nowMs: now }
  );
  eq(plan.errors, [], 'valid batch');
  eq(plan.planned[0].duplicateOf, 500, 'same start minute, project and description is a duplicate');
  eq(plan.planned[1].overlaps, ['500'], 'overlap with an existing entry');
  eq(plan.planned[2].overlaps, ['#1'], 'overlap with an earlier batch item');
  eq(plan.planned[1].write.tags, ['D-200 Phase two'], 'canonical tag name written');
  eq(plan.planned[1].write.duration, 5400, 'duration_minutes');
  eq(plan.planned[1].write.start, '2026-10-29T09:30:00.000Z', 'UTC start written');

  const badPlan = entries.planEntries(
    [
      { start: '2026-10-29T11:00', stop: '2026-10-29T10:00', description: 'x', project: 'Alpha' },
      { start: '2026-10-29T09:00', description: 'x', project: 'Nope', tags: ['D-999'] },
      { start: '2026-10-29T09:00', duration_minutes: 20 * 60, description: 'x', project: 'Alpha' },
    ],
    account,
    [],
    { allowNewTags: false, nowMs: now }
  );
  eq(badPlan.planned.length, 0, 'nothing planned from an invalid batch');
  ok(/#0: stop must be after start/.test(badPlan.errors[0]), 'stop before start');
  ok(/#1: Give exactly one/.test(badPlan.errors[1]) && /Unknown project/.test(badPlan.errors[1]) && /Unknown tag/.test(badPlan.errors[1]), 'all problems of one item reported together');
  ok(/#2: Longer than 16h/.test(badPlan.errors[2]), 'over-long entry refused');

  // avoid_projects: trimmed around an entry of another project, skipped when inside it.
  const lunch = [{ ...existing[0], id: 600, project_id: 11, start: '2026-10-29T10:00:00Z', stop: '2026-10-29T10:30:47Z', duration: 1847, description: 'Lunch' }];
  const around = entries.planEntries(
    [
      { start: '2026-10-29T11:30', stop: '2026-10-29T13:00', description: 'After lunch', project: 'Alpha' },
      { start: '2026-10-29T11:05', stop: '2026-10-29T11:20', description: 'Inside lunch', project: 'Alpha' },
      { start: '2026-10-29T14:00', stop: '2026-10-29T15:00', description: 'Untouched', project: 'Alpha' },
    ],
    account,
    lunch,
    { allowNewTags: false, nowMs: now, avoidProjectIds: [11] }
  );
  eq(around.planned[0].write.start, '2026-10-29T10:30:47.000Z', 'start moved to the end of the avoided entry (seconds kept)');
  eq(around.planned[0].write.duration, 5353, 'duration shrinks accordingly');
  eq(around.trimmed.map((t) => t.index), [0], 'trim reported');
  eq(around.skippedInside.map((s) => s.index), [1], 'entry inside the avoided one skipped');
  eq(around.planned.map((p) => p.index), [0, 2], 'the rest planned');
  eq(around.planned[0].overlaps, [], 'no overlap left with the avoided entry');

  const t = entries.totals(existing, now);
  eq(t.days, [{ date: '2026-10-29', hours: 2 }], 'day totals');
  eq(t.weeks, [{ week_starting_saturday: '2026-10-24', hours: 2 }], 'Saturday–Friday week totals');
}

// ─── Updates ────────────────────────────────────────────────────────────────

{
  // 02:30:45 CEST on the night the clocks go back: the repeated hour.
  const before = {
    project_id: 10,
    description: 'Night shift',
    tags: ['D-100', 'Brand new'], // "Brand new" came from an earlier allow_new_tags write
    billable: false,
    start: '2026-10-25T00:30:45.000Z',
    stop: '2026-10-25T01:30:45.000Z',
    duration: 3600,
  };
  const longer = applyUpdate({ id: 1, duration_minutes: 90 }, before, account, false);
  eq(longer.start, before.start, 'changing only the length keeps the exact start (seconds, DST hour)');
  eq(longer.duration, 5400, 'new length');
  const stopOnly = applyUpdate({ id: 1, stop: '2026-10-25T01:45:00Z' }, before, account, false);
  eq(stopOnly.start, before.start, 'changing only the stop keeps the exact start');

  const tagged = applyUpdate({ id: 1, add_tags: ['D-200'] }, before, account, false);
  eq(tagged.tags, ['D-100', 'Brand new', 'D-200 Phase two'], 'kept tags are not re-validated; added ones are');
  const removed = applyUpdate({ id: 1, remove_tags: ['Brand new'] }, before, account, false);
  eq(removed.tags, ['D-100'], 'a tag unknown to the catalog can be removed');
  assert.throws(() => applyUpdate({ id: 1, tags: ['D-999'] }, before, account, false), /Unknown tag/);
  checks++;
}

// ─── Timesheet ──────────────────────────────────────────────────────────────

{
  // A workspace as Settings stores it (PresetValue), at the defaults.
  const value = {
    selectedProjects: [{ id: 10, name: 'Alpha' }],
    groupName: '',
    shortFriday: false,
    weeklyHours: 40,
    maxBillableHours: null,
    minWorkingDayHours: null,
    billingTagPrefix: 'D',
    billByProject: false,
    stripCodeParens: false,
    timeOffTag: '.Time Off',
    roundingHours: 0.25,
    startWindowHours: null,
    maxDescriptionLength: null,
    noOvertime: false,
    balanceWeekdays: false,
    codeMappings: [],
    timesheetMode: 'summary' as const,
    exportName: '',
    exportFields: EMPTY_EXPORT_FIELDS,
  };
  const payload = {
    v: 1,
    settings: { ...value, presets: [{ id: 'p1', name: 'Client A', value }], activePresetId: 'p1' },
    exportFields: value.exportFields,
  };
  const ws = timesheet.resolveWorkspace(payload as never, 'client a');
  eq(ws.id, 'p1', 'workspace by case-insensitive name');
  eq(timesheet.resolveWorkspace(payload as never).name, 'Client A', 'active workspace by default');
  assert.throws(() => timesheet.resolveWorkspace(payload as never, 'Nope'), /Stored workspaces: "Client A"/);
  checks++;

  const mk = (id: number, start: string, mins: number, desc: string, tags: string[]) => ({
    id,
    start,
    stop: new Date(Date.parse(start) + mins * 60000).toISOString(),
    duration: mins * 60,
    project_id: 10,
    workspace_id: 1,
    description: desc,
    tags,
  });
  const list = [
    mk(1, '2026-10-26T08:00:00Z', 120, 'Design', ['D-100']),
    mk(2, '2026-10-26T10:00:00Z', 7, 'Stray', []),
    mk(3, '2026-10-27T08:00:00Z', 60, 'Two codes', ['D-100', 'D-200 Phase two']),
  ];
  const range = time.dateRange('2026-10-24', '2026-10-30');
  const built = timesheet.buildTimesheet({
    workspace: ws,
    accountName: 'Test Person',
    entries: list,
    fromMs: range.fromMs,
    toMs: range.toMs,
    view: 'summary',
    nowMs: Date.parse('2026-11-01T12:00:00Z'),
  });
  const direct = buildExportDoc({
    view: 'summary',
    range,
    entries: list,
    nowMs: Date.parse('2026-11-01T12:00:00Z'),
    projects: value.selectedProjects,
    multi: false,
    maxBillableHours: 4,
    billingTagPrefix: 'D',
    roundingSeconds: 900,
    noOvertime: false,
    weeklyHours: 40,
    title: 'Alpha',
    personName: 'Test Person',
  });
  eq(built.doc.grandTotal, direct.grandTotal, 'same billed total as the export builder');
  eq(built.doc.grandTotal, 7200, 'only the tagged entry bills');
  ok(!built.checks.ok, 'checks fail');
  eq(
    built.checks.warnings.map((w) => [w.date, w.minutes, w.desc]),
    [
      ['2026-10-26', 7, 'Stray'],
      ['2026-10-27', 60, 'Two codes'],
    ],
    'untagged and multi-tagged entries flagged, unrounded'
  );
  const compact = timesheet.compactDoc(built.doc);
  ok(compact.view === 'summary' && compact.total_hours === 2, 'compact summary in hours');
  ok(timesheet.toCSV(built.doc).includes('D-100'), 'CSV has the billing code');
  eq(timesheet.describeWorkspace(ws).rounding_minutes, 15, 'workspace description');
  ok(!('signatureImage' in timesheet.describeWorkspace(ws)), 'no export identity details in the description');
}

console.log(`✓ ${checks} MCP checks passed`);
