# toggl-track-quick-view

A single-screen dashboard for tracking your work day against a weekly target,
reading from Toggl Track or from its own database. Open it on a spare monitor and
see at a glance:

- **Whether you are tracking**: a live badge (this project, another project, or
  nothing).
- **How much you have tracked today**: a ring and a clock that ticks while a
  timer runs.
- **How much is left**: the remaining time to today's target.
- **When to take a break**: an alert after 4.5h of continuous work.

It also builds a copy-paste-ready **timesheet** for the week and exports it as
CSV, XLSX or PDF.

You normally pick one project. In Settings, **Track more than one project** lets
you select several; they then count as one pool for every target, ring and break
calculation. They stay separate only in the timesheet, where each billing code is
grouped per project and prefixed with the project name. Small initials chips in
the project colour show which projects are in the group.

## Running locally

```bash
pnpm install
pnpm env:pull    # generate .env from .env.tpl via 1Password
pnpm env:check   # report missing or contradictory variables
pnpm dev         # start MongoDB and Next on http://localhost:3000
```

Without 1Password, run `cp .env.tpl .env` instead of `env:pull`. The only
placeholder in it is `TOGGL_API_TOKEN`; leave it blank and the app asks for a
token in Settings.

The default `.env` gives the plain Toggl dashboard: no password, no database.
Open Settings (⚙), pick your project, and optionally turn on **Short Friday** or
change **Hours worked per week**.

`pnpm dev` also starts a local MongoDB in Docker (port 27018) and stops it on
Ctrl-C if it started it. It is only used once you enable settings sync or
standalone mode; see [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

## Deploying to Vercel

1. Import the repository in Vercel. It is detected as Next.js and needs no
   extra configuration.
2. Optional: set `TOGGL_API_TOKEN` so nobody has to enter a token in the
   browser.
3. Optional: set `APP_PASSWORD` to put the dashboard behind a password (see
   [Password protection](#password-protection)).

With no variables at all, the deployment is a bring-your-own-token dashboard:
each visitor enters their own Toggl token, which stays in their browser.

`MONGODB_URI` and `APP_MODE` together decide what the deployment is:

| `MONGODB_URI` | `APP_MODE` | Result |
| --- | --- | --- |
| unset | (any) | Toggl mode, no sync |
| set | unset | [Standalone mode](#standalone-mode-no-toggl): own store, Toggl never contacted |
| set | `toggl` | Toggl mode with [settings sync](#settings-sync-across-devices) |

The `vercel-build` script runs `pnpm env:check` before `next build`, so a missing
or contradictory variable fails the deployment. Every variable, the 1Password
layout and the Vercel environments are described in
[docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

**Deploying your own instance:** `DEPLOYMENT_TOPOLOGY` in
`scripts/env-spec.mjs` lists what this repository's own deployments must have.
None of it is required by the app. Empty that object and every variable becomes
optional again; the format and contradiction checks still apply.

Preview deployments are also served at `beta.track.zicha.dev`, which
`.github/workflows/preview-alias.yml` points at the newest successful preview.
The password session and the installed PWA are tied to the origin, so a fixed
host keeps both across deployments. The workflow needs a `VERCEL_TOKEN`
repository secret.

## How it talks to Toggl

Toggl's API cannot be called from a browser (its CORS whitelist is closed), so
every call goes through a same-origin proxy at `app/api/toggl/[...path]`. The
token is sent only to that proxy and to Toggl.

The API token, selected project and preferences live in the browser's
`localStorage`. If `TOGGL_API_TOKEN` is set, the app connects with it
automatically and hides the token field. A token entered in the browser takes
precedence over the server's.

After a deploy, open tabs notice the new build (they check `GET /api/version` on
focus and periodically) and ask you to refresh. With settings sync this matters:
a tab on an old build does not know newer settings keys and would drop them on
its next save.

## Password protection

Set `APP_PASSWORD` to gate a deployment that holds data of its own, meaning one
with `TOGGL_API_TOKEN` or `MONGODB_URI` set. Without either, each visitor brings
their own token and the password has no effect.

- Nothing is fetched or shown until the password is accepted. The check runs on
  the server, so it cannot be bypassed by calling the API directly.
- The password is never stored. The server returns a signed session token valid
  for 7 days, and the browser keeps only that (in `localStorage`).
- The session is signed with a key derived from the password, so changing
  `APP_PASSWORD` ends every session immediately.
- Wrong guesses get an increasing delay. The delay is per server instance, so on
  serverless it is best-effort; use a long random password.

`localStorage` is readable by any script on the page. The app loads no
third-party scripts, so the remaining risk is XSS.

## Standalone mode (no Toggl)

With `MONGODB_URI` set and `APP_MODE` unset, the app keeps its own time entries
in MongoDB (a free Atlas M0 cluster is enough) and never contacts Toggl.
`APP_PASSWORD` is required, since the store accepts writes. `MONGODB_DB` picks
the database name (default `toggl-quick-view`).

- The **Tracker** page (`/tracker`) replaces Toggl's timer view: start/stop,
  manual entries, inline editing, billing-tag autocomplete, continue, delete, and
  a list grouped by day and week.
- **Workspaces** are stored on the server. Each one has its own settings and time
  entries, syncs across devices, and acts as the selectable "project" on the
  dashboard and timesheet, so multi-project tracking, billing codes, timesheets
  and exports work as in Toggl mode.
- [Linked billing codes](#linked-billing-codes-subcontracting) can point at
  another stored workspace.
- Every device refreshes every 30 seconds and immediately after a change. There
  is no request budget, and `TOGGL_API_TOKEN` / `TOGGL_CACHE_INTERVAL` are
  ignored.
- **Import** (`/import`) brings in Toggl history: connect with your Toggl token,
  map each Toggl project to a workspace (existing, new, or skipped), pick a
  range and run. It pages through history oldest first in ~90-day windows,
  pausing to stay within Toggl's rate limit. Re-running it skips entries already
  imported.

## Settings sync across devices

With a database, your setup follows you between devices: stored workspaces,
targets, billing options, timesheet options and the export details.

- **Standalone mode:** always on.
- **Toggl mode:** set `MONGODB_URI`, `APP_PASSWORD` and `APP_MODE=toggl`. The
  database then holds settings only.

Changes upload shortly after you make them. Other devices pick them up on load
and when the page regains focus, and a new device adopts the synced setup
without asking. Every write is checked against a revision number; if two devices
changed settings since their last common revision, **Settings → Sync &
transfer** shows both and asks which to keep.

If a newer setup arrives while Settings or the export dialog is open, their
fields are reloaded and the app tells you, so saving does not overwrite the newer
values. In standalone mode the workspace list is also re-read on focus.

**Never synced:** the Toggl API token (the server also strips it from anything
it receives) and the refresh interval.

**Without a database**, **Sync & transfer** can download the whole setup as a
JSON file (without the token) and import it on another device. This works on
every deployment.

## Install as an app

The app has a web manifest and icons, so it can be installed and run in its own
window. It is not offline-capable: the service worker (`public/sw.js`) exists
only for installability and caches nothing.

The **Install as an app** block at the bottom of Settings adapts to the browser:

- **Chrome, Edge, Android:** the button opens the browser's own install dialog.
  The browser's other install prompts still work.
- **iPhone and iPad (any browser), Safari 17+ on the Mac:** the button opens a
  walkthrough: Share → **Add to Home Screen**, or File → **Add to Dock** on the
  Mac. In-app browsers (Slack, Teams, mail apps) and third-party browsers on iOS
  older than 16.4 are first told to open the page in Safari.
- **Anywhere else, or inside the installed app:** the block is hidden.

The rules are in `lib/pwa.ts`, tested by `pnpm check:pwa`. Preview deployments
install as **Toggl Quick View (beta)**, so they can sit next to the production
install.

## Targets

Targets aim for **Hours worked per week** (Settings, default 40h). The figures
below are for 40h; every target, floor and cap scales linearly with the weekly
hours. A 20h week, for example, becomes 4h a day, or `4.5 / 4.5 / 4.5 / 4 / 2.5`
with Short Friday. The break reminder does not scale.

The week runs Saturday to Friday. Weekend days have a nominal 8h target but add
nothing to the weekly budget; hours logged on them count toward the adaptive
days below. A day's target depends only on hours logged before that day, so it
does not shrink as you work.

| Day | Standard | Short Friday |
| --- | --- | --- |
| Mon–Wed | 8h | 9h |
| Thu | Half of what remains for the week, at least 7h | What remains minus 5h for Friday, between 8h and 9h |
| Fri | What remains for the week, at least 5h | What remains for the week, at least 5h |

No day's target exceeds 12h.

### Month boundaries

When the 1st of a month falls mid-week, the week is split there and each part is
budgeted separately at 8h per weekday it contains. Hours on one side never count
toward the other. Within each part, its last weekday takes the Friday role and
the one before it the Thursday role. So with the 1st on a Friday, Friday gets a
full standard day however much you worked Mon–Thu, and any surplus from Mon–Wed
shortens Thursday instead.

### Advanced targets

Under **Settings → Advanced targets**. Each of the first two shows its scaled
default; leave it blank to keep scaling, or enter a value to fix it.

- **Maximum individually billed timesheet** (4h): the longest a single entry
  can be and still bill as one line. Longer entries are flagged.
- **Minimum target working day** (5h): the floor for the closing day of the
  week.
- **Round timesheet to**: the unit timesheet entries are rounded to. 15 minutes
  by default; also 12 minutes, 30 minutes or 1 hour. Affects the timesheet and
  exports only.
- **Timesheet lines may start**: a coarser grid for start times in the
  Individual view, for clients that take quarter-hour durations but want lines
  to start on `:00` or `:30`. Durations and totals are unaffected. It only
  appears when a coarser grid than the rounding unit exists.

### Time off

An entry tagged with the **time off tag** (default `.Time Off`, set under
Advanced) makes its day a non-working day, like a weekend. Its length does not
matter.

- The day's target is 0h and the week's budget drops by a day (a 40h week with
  one holiday becomes 32h). The "Don't bill overtime" cap shrinks the same way.
- The marker entry is never billed, counted or exported, and never triggers a
  missing-tag warning.
- Other work tracked that day counts in full and is billed whole.

Only entries on the tracked projects count, so a day can be off in one workspace
and a working day in another. Such days show a **holiday** pill in the timesheet
and an **off** pill in the dashboard's week summary.

## Breaks and unreported time

**Break reminder.** After 4.5h of continuous work on the selected project, an
alert asks you to take a break. A gap of 10 minutes or more, or switching to a
different project, counts as a break. The alert can be snoozed for 15 minutes.

**Unreported time.** The side panel lists gaps today and yesterday where no timer
ran on any project. Time before the first entry and after the last is not
counted, and gaps under a minute are ignored. The **Today / Yesterday** timeline
draws each gap as a red dashed divider. This uses the week's data already
fetched, so it costs no extra API calls.

## Billing codes

Each entry on the selected project should carry one **billing tag**: a Toggl tag
starting with the billing tag prefix (default `D`, e.g. `D123`, set under
Advanced). The tag says which timesheet line the time bills to. Entries without
one get a small ⚠ on the dashboard timeline.

### Overtime markers

Append a marker to a billing tag to control how [Don't bill
overtime](#dont-bill-overtime) treats that time. Both merge into the plain code's
line (`D123(X)` and `D123(!)` bill as `D123`) and are never shown or exported.

- `(X)`: disposable. Trimmed first, down to zero if needed.
- `(!)`: protected. Never trimmed; it still counts toward the cap, so other lines
  are trimmed instead.

### Strip parentheses from billing codes

Under Advanced, off by default. Turns `D123 (Phase 2)` into `D123` everywhere:
billing, display and exports. Overtime markers are read first, so
`D123 (Phase 2)(!)` still protects its time. Codes that differ only in the
parenthesis merge into one line. This is a per-workspace setting.

### Support tickets

An entry with no billing tag whose description starts with a bracketed id bills
to that id:

> `[T-1234] Fix login redirect` bills to `T-1234` with the description
> "Fix login redirect".

The id needs no prefix, an explicit billing tag wins over it, and overtime
markers work inside the bracket (`[T-1234(X)] …`). It is always on. In the
standalone tracker the derived code shows as a dashed chip; click it to set an
explicit tag.

### Bill by project

Some engagements bill one line per project. **Bill by project** (under Advanced,
per workspace) makes every entry bill to its project's name:

- There are no missing-tag or multiple-tag warnings, and no ⚠ on the dashboard.
- Timesheet rows and export columns are headed **Project**, without a
  project-name prefix.
- Billing tags, ticket brackets, overtime markers, parentheses and linked codes
  are ignored, and their settings are hidden (but kept, so turning this off
  restores them).
- Rounding, start grid, description limit, billable-length cap, overlap
  warnings, Don't bill overtime and the time off tag all still apply.
- The standalone tracker hides the billing-tag chip for such a workspace.

## Workspaces

A **workspace** is a named snapshot of your settings: project selection, targets,
billing options and export details. Use one per client.

- **Settings → Workspaces**: type a name and **Save current**. Click a stored
  workspace to switch to it. **↻** re-captures the current settings into it,
  **✎** renames, **🗑** deletes.
- Once one exists, the dashboard top bar shows a workspace menu next to
  **Timesheet** for switching. If your live settings match no stored workspace,
  it reads **Workspace**. **Manage workspaces…** opens the Settings section.
- Editing live settings never changes a stored workspace; only **↻** does.

A workspace captures everything except the API token and the refresh interval.
In Toggl mode the list lives in `localStorage` (and syncs if settings sync is
on).

### Export details are per workspace

The export dialog's details (company, client, role, approver, reference, rate,
engagement note, start date, signature image) belong to the workspace you are on,
so one client's details never end up on another's PDF.

- A new workspace starts with the details currently in use.
- After that, anything you enter in the export dialog is saved straight to the
  current workspace. No **↻** is needed.
- Two workspaces may differ only in these details; the app remembers which one
  you recalled.
- With no workspace stored, or live settings matching none, the details belong to
  the device.
- **Role** and **engagement note** are kept per template language. A language
  left empty falls back to the other one.
- **Start date** is the engagement's first billable day. Week and month presets
  are clipped to it, so an engagement starting Aug 16 exports Aug 16–31 as its
  first month. Custom dates are not clipped.

**Settings → Advanced targets → Export details** lists which details are set.
They are edited in the export dialog.

## Timesheet

**Timesheet** (top right, or `/timesheet`) shows the current week ready to copy
into an external timesheet. **Settings → Timesheet view** picks the default
layout: **Summary** or **Individual**. Both reuse the dashboard's week fetch, so
they cost no API requests.

**Previous weeks** lists recent weeks without fetching anything. Selecting a week
fetches it once and keeps it in memory until reload. Past weeks do not
auto-refresh; **↻ Refresh** fetches live data, bypassing the shared server cache.
The live poll pauses while you view a past week and resumes on **This week**.

### Summary

- Days are columns (Sat/Sun only when tracked), billing codes are rows.
- Each cell sums a day's entries for a code and merges their descriptions
  (`; `-separated, duplicates removed). A copy button copies the description.
- Hours are decimal (e.g. `8.25h`), rounded to the rounding unit. Rounding is
  spread across a day's cells (largest-remainder method) so they add up to the
  rounded day total.

### Individual

- One section per day, one row per entry: start–end time, rounded hours, code
  and description, with a copy button.
- Starts snap to the rounding unit (or the start grid, if set) on the local
  clock, and each end is start plus rounded duration. Rows are pushed forward so
  they never overlap, but never past the day they were tracked on.
- Adjacent entries with the same code merge when they are within an hour of
  each other and the result stays within the billable maximum (4h at 40h).
  `D-1, D-2, D-1` stays three rows.
- Rounding works as in Summary, but favours keeping small entries visible.

### Warnings

Both views flag, in amber: **No billing tag**, **Multiple billing tags**, and in
Individual also **Too long to bill individually** (over the billable maximum)
and **Overlapping entries**. Warning rows are on-screen only: they do not count
toward totals and never appear in exports, so the view and the export always
agree.

### Don't bill overtime

For engagements that forbid billing more than the agreed hours. With **Don't
bill overtime** on (under Advanced), each week's billed total is capped at
**Hours worked per week**, trimming whole rounding units:

1. `(X)`-marked time goes first.
2. Then the rest, except `(!)`-marked time and linked-code lines, which are never
   trimmed. If those alone exceed the cap, the total stays above it.

The Individual view spreads the cut in proportion to each line's size. The
Summary view bills the weekend in full and evens out the weekdays toward a common
ceiling. Only billable lines count toward the cap; warning rows never do.

A week split by the 1st of a month gets a cap per part, 8h (at 40h) per weekday
it holds. A weekend-only part is capped at zero. Holidays reduce the cap the same
way.

The trimmed time appears in the views on a muted **Overtime (not billed)** line.
Exports contain only the billed figures.

### Max description length

For client systems that reject long descriptions. Set **Maximum description
length** (under Advanced; blank means no limit) and every description in the
views, copy buttons and CSV/XLSX fits:

- A single entry that fits is unchanged.
- A merged description keeps parts in order while they fit and ends with `; …`.
  A linked-code breakdown is always the first part, so it survives.
- A single description that is too long on its own is cut with `…`.

Shortened text shows an amber **✂**; hover for the full text. Warning rows are
never shortened. PDFs use full text by default; when a limit is set, the export
dialog's **Descriptions** option can switch the PDF to the shortened text.

### Linked billing codes (subcontracting)

Use this when you work for a prime contractor who bills the whole engagement
under one code, but the work is tracked for a sub-client with its own codes and
possibly its own rounding and overtime rules. A linked code (**Advanced → Linked
billing codes**) says, for one selected project:

- its entries carry the sub-client's tags (their own prefix, e.g. `S101`),
  validated as usual;
- each day they are grouped by those codes and rounded on the link's own unit
  (a whole multiple of this sheet's unit), as the sub-client's sheet would show
  them;
- the day's rounded total bills here as the single target code (e.g.
  `D-SUB-1`).

So each day, the sub-client's codes sum to this sheet's linked line. The line's
description starts with the breakdown (e.g. `S101 1.75h, S102 0.50h`). In the
Individual view the linked project is one block per day, placed at its first
entry.

**Setup**, billing prime client P for work done for sub-client S:

1. **In Toggl:** create a project for S's work and tag its entries with S's
   codes (one per entry).
2. **Prime workspace:** select P's project(s) and S's project (the linked project
   must be selected). Add the linked code: pick S's project, its prefix, its
   rounding and the code it bills as here. If S's contract forbids overtime,
   tick **It doesn't bill overtime** and enter S's weekly cap. Save as a
   workspace.
3. **Sub-client workspace:** only S's project, its prefix, rounding and targets,
   no linked code. This produces the sheet you hand to S.

**Overtime.** This sheet's Don't bill overtime never trims a linked line, since
it must match S's sheet; the linked hours still count toward the cap, so the
other lines absorb the cut. The link's own **It doesn't bill overtime** applies
S's cap upstream with the same rules S's sheet uses. Keep it in step with the
sub-client workspace's setting.

In standalone mode the link can target another stored workspace instead of a
Toggl project. The logic is in `lib/timesheet/mapping.ts`.

## Exports

The timesheet exports to CSV, XLSX and PDF. Exports use the same figures as the
view.

### PDF templates

The export dialog's **PDF template** picker chooses the layout. This repository
ships one, **Timesheet**: your name, the period, and the tables as shown on
screen, with no logo or embedded typeface. The picker appears only when there is
more than one template.

### Digital signature

A template can declare a signature area (the built-in Timesheet does not). For
such templates the export dialog offers **Digital signature → Sign the PDF**,
which adds a PAdES signature over the whole file, with the visible block in the
issuer's box. Boxes for the client's countersignature stay blank.

- **Sign with**: **Hardware token via Sign Bridge** signs with a certificate on
  a smart card. Sign Bridge is a browser extension plus a local helper app; the
  dialog says which part is missing. The **throwaway key** is always offered: a
  key generated in the browser and discarded with the tab. Its signatures are
  valid (`PAdES-BASELINE-B`) but chain to nothing, so no viewer trusts them. It
  exists to test the pipeline without a card.
- **Certificate**: **Connect and list certificates** pairs with the helper
  (approve only if the code shown matches the page). Cards often hold a
  qualified signing certificate and an authentication certificate for the same
  person; signing with the second gives a valid but non-qualified signature, and
  the dialog warns when you pick one.
- **Handwritten signature**: a PNG or JPEG scan, embedded in the visible block.
  It is stored with the workspace, so it reaches your deployment and syncs with
  your settings. Scans over ~190 kB are used for that export only. No signature
  image ships with the app.
- **Signature block layout**: image above or beside the certificate details,
  with a preview at printed size.

The image is cosmetic; the certificate is what signs. With signing off, the
export is unchanged. Design and status: [docs/pdf-signing-v2.md](docs/pdf-signing-v2.md).

### Adding a PDF template

A template is one `PdfTemplate` object: its name, the details the export dialog
should ask for, and a function that turns an export document into a
[pdfmake](https://pdfmake.github.io/docs/) document definition. Nothing else in
the export pipeline knows about templates. The contract is in
`lib/export/pdf/types.ts`; `lib/export/pdf/timesheet.ts` is a complete example.

```ts
import type { PdfTemplate } from '@/lib/export/pdf/types';

export const invoiceAnnex: PdfTemplate = {
  id: 'invoice-annex',             // stable: devices remember their pick by id
  name: 'Invoice annex',           // shown in the picker
  description: 'One line per day, totalled by billing code.',
  fields: ['client', 'reference'], // which dialog inputs to show (see below)
  locale: 'en',                    // language the document prints in
  build: (doc) => ({ content: [ /* pdfmake */ ] }),
};
```

Register it in `APP_TEMPLATES` in `lib/export/pdf/templates.ts`, or ship it in a
[pack](#private-template-packs).

| Key | |
| --- | --- |
| `id` | Stable identifier; renaming is free, changing the id is not. Lowercase, digits and dashes. |
| `name` | Shown in the picker. |
| `description` | One or two sentences shown under the picker. |
| `fields` | Identity details the dialog collects for this template. Unlisted fields are never asked for. |
| `fieldHints` | Placeholder text per field. |
| `locale` | `'en'` or `'cs'`. Decides which language's role and engagement note the dialog shows and stores. |
| `loadFonts` | Optional async loader for embedded fonts. Without it, pdfmake's bundled Roboto is used. |
| `signatureWidget` | Optional. Makes the template signable; see below. |
| `build` | `(doc: ExportDoc) => TDocumentDefinitions`. Must be pure. |

`pnpm check:templates` checks every registered template: unique ids, valid
fields, and that `build()` handles Summary, Individual, an empty range and a
document with no rate.

#### What the template gets

`build()` receives an `ExportDoc` (`lib/export/model.ts`): the timesheet already
rounded, merged, capped and trimmed as on screen. A template formats; it never
recomputes. Durations are **seconds** throughout; `secsToHoursLabel()` in
`lib/export/model.ts` formats them like the screen.

Every document has:

| Field | |
| --- | --- |
| `view` | `'summary'` or `'individual'`. |
| `title` | Project or group name. |
| `personName` | Who the timesheet is for. |
| `fromMs`, `toMs` | Local-midnight epoch ms; `toMs` is exclusive. |
| `multi` | Several projects exported together (codes carry a project prefix). |
| `billByProject` | The workspace bills by project: each row's `billingCode` is its project name and carries no prefix. |
| `grandTotal` | Rounded seconds for the whole period. |
| `role`, `company`, `client`, `approver`, `reference`, `engagement` | Identity fields as entered. Empty string means not given. |
| `rate`, `rateBasis`, `currency` | `rate` is `null` for a time-only document; `rateBasis` is `'hourly'` or `'md'`. Templates that print money must handle `null`. |

A Summary document has `weeks[]`:

| | |
| --- | --- |
| `weekStart`, `label` | Start of the week and its label. |
| `dayLabels[]`, `dayDates[]` | Header text and local-midnight ms per visible day. |
| `rows[]` | Per billing code: `label` (project-prefixed when `multi`), `billingCode`, `project`, `cells[]` (seconds per day), `dayDescs[]`, `desc`, `total`, `warn`. |
| `dayTotals[]`, `grandTotal` | Column totals and week total. |

An Individual document has `days[]`, one per day with time on it:

| | |
| --- | --- |
| `dateMs`, `label`, `total` | The day, its label and its rounded total. |
| `rows[]` | Per entry group: `time` (rendered range or `null`), `startMs`/`endMs`, `hours` (seconds, despite the name), `code`, `billingCode`, `project`, `desc`, `warn`. |

`warn` marks rows the screen flags as wrong (untagged or multi-tagged).

For money, use `lib/export/pdf/money.ts`: currency formatting, and `allocate()`,
which makes printed subtotals add up to the printed total. Rounding each row
with `toFixed()` drifts.

#### Identity fields

Values are always entered by the user and stored with the workspace, so no
company, client or rate ships with the app.

| Field | The dialog asks for | On the document |
| --- | --- | --- |
| `role` | The person's role, in the template's language | `doc.role` |
| `company` | The supplier company | `doc.company` |
| `client` | The client billed | `doc.client` |
| `approver` | Who countersigns | `doc.approver` |
| `reference` | Document reference, default `TS-YYYY-MM` | `doc.reference` |
| `engagement` | Free text in the template's language | `doc.engagement` |
| `rate` | Rate, currency, and hourly or per man-day | `doc.rate`, `doc.currency`, `doc.rateBasis` |

#### Fonts

Roboto covers Latin Extended (Czech is fine; Cyrillic and Greek are not). To
embed other fonts, return pdfmake's font declarations and virtual file system
together:

```ts
loadFonts: async () => {
  const { vfs, fonts } = await import('./myFonts');
  return { vfs, fonts };
},
```

pdfmake maps a style to a filename and looks that up in the VFS, and a mismatch
only fails at render time for text that needs the missing file.
`pnpm check:fonts` checks that they agree, that the data decodes to real fonts,
and that each font has a full character map (pdfmake has no glyph fallback, so
a subset renders missing characters as boxes). The loader runs only when that
template exports.

#### Making a template signable

Signing (the certificate, CMS, timestamp and visible stamp) is handled by the app
in `lib/export/pdf/sign`. A template only promises where the stamp goes:

```ts
signatureWidget: {
  rect: { x: 62, y: 620, width: 216, height: 92 },  // pdfmake coords, from the top-left
  page: { width: 595.28, height: 841.89 },          // what the rect is measured against
  fontFamily: 'IBMPlexSans',                        // optional; must be declared by loadFonts()
}
```

The rect must be empty, on the **last page**, at exactly those coordinates. The
signing step only sees the finished PDF, so the template has to guarantee this,
using both:

1. **Reserve the space.** End the content with an invisible node as tall as the
   signature row, so pdfmake moves it (and the row) to a new page when it does
   not fit. It must be a real drawing with non-zero size; pdfmake ignores
   zero-size nodes when deciding page breaks.
2. **A `pageBreakBefore` rule** keyed on that node's `id`, so the guarantee does
   not rest on the measured height alone.

Draw the box at a fixed `absolutePosition`. Nothing may flow after the row, so
put footnotes above it.

A `fontFamily` not declared by `loadFonts()` fails only at signing time, after
the PIN is entered; `pnpm check:signature` catches that. It tests the signing
code against `scripts/signatureFixture.ts` and any signable pack templates.

Leave `signatureWidget` off unless the layout reserves room: otherwise the stamp
is drawn over the content.

### Private template packs

Client-specific templates can live in a separate, private repository and be
built into your deployment without being in this one.

A pack is plain source. Its `index.ts` default-exports:

```ts
import type { TemplatePack } from '@/lib/export/pdf/types';

export default {
  name: 'my-templates',
  templates: [ /* PdfTemplate[] */ ],
  defaultTemplateId: 'my-headed-sheet',   // optional
} satisfies TemplatePack;
```

Set `PDF_TEMPLATE_PACK_REPO` to its repository, `PDF_TEMPLATE_PACK_TOKEN` if it
is private, and optionally `PDF_TEMPLATE_PACK_REF`. Before `next dev` and
`next build`, `scripts/sync-pack.mjs` checks it out into `pdf-templates/` (gitignored),
and the `@pdf-template-pack` alias resolves to it, or to
`lib/export/pdf/emptyPack.ts` when it is absent. Pack templates are listed first
and the pack may set the default. `pnpm pack:sync` runs the checkout alone;
`pnpm check:pack` runs the pack's own `checks/`.

- **Without a pack** the app is complete and exports with the Timesheet
  template.
- **A configured pack that cannot be fetched fails the build**, so a deployment
  never silently loses its templates. Offline, an existing checkout is kept.
- **`pdf-templates/` is overwritten** at the configured ref on every sync. Edit
  the pack in its own clone and push.
- The directory, not the variable, decides what is built in. Clearing
  `PDF_TEMPLATE_PACK_REPO` stops updates but keeps an existing checkout;
  delete `pdf-templates/` to build without it.

It is not a git submodule, because that would make every clone and fork of this
public repository try to fetch the private one.

## Toggl rate limits

Toggl's Free plan allows **30 API requests per hour** per user (the `/me`
endpoint has a separate 30/hour budget). The app stays under it:

- **One request per refresh.** The week's time entries include the running
  timer.
- **Cached connect.** The workspace and project list are cached for 24h. A
  project created in Toggl after that will not appear until you click **↻
  Refresh project list** in Settings. Only projects from your default Toggl
  workspace are listed.
- **Refresh interval**, default 3 minutes (~20 requests/hour), from 1 minute
  (paid plans) to 10 minutes. The clock ticks locally between refreshes.
- **No requests while the tab is hidden**; it refreshes when you return.
- **Backoff** on HTTP 402/429, doubling the wait up to 15 minutes.
- A **budget meter** in the footer estimates requests in the last hour and turns
  amber near the limit.

Every open tab and device spends from the same budget. Use one, raise the
interval, or turn on the shared server cache.

### Shared server cache

For several devices sharing a server token, set `TOGGL_CACHE_INTERVAL` (requires
`TOGGL_API_TOKEN`). All devices are then served from one in-memory cache in the
proxy (`lib/serverCache.ts`):

- Only the first request after the cache goes stale calls Toggl, so upstream use
  is about one request per interval however many devices are open.
- There is no background timer: with nobody watching, no requests are made.
- Simultaneous requests share one upstream call.
- On an error or rate limit, the last good data is served.
- The per-device refresh interval picker is hidden; devices poll at the server's
  interval.

The value is in **seconds**. Keep it at 120 or above on the Free plan. `1`,
`true` or `on` means the default of 180 (~20/hour); the minimum is 30.

The cache lives in one server instance's memory. On serverless with several
instances each keeps its own, which is never worse than no cache.

## Tuning constants

The target thresholds are the `BASE_*` values at the top of
[`lib/calc.ts`](lib/calc.ts), tuned for a 40h week and scaled by
`resolveTargets()`. The unscaled ones are exported: `BREAK_AFTER_HOURS`,
`BREAK_GAP_MINUTES` and `UNREPORTED_MIN_MINUTES`.
