# toggl-track-quick-view

A single-screen quick view for tracking your work day on a Toggl Track
client/project. Open it on a spare monitor and see, at a glance:

You normally pick **one** project, but you can track **several at once** — in
Settings, click _"Track more than one project"_ to multiselect. The selected
projects then count as a single pool for every target, ring and break
calculation; they stay distinct only in the timesheet, where each billing tag is
grouped per project and prefixed with the project name. Tiny initials chips
(colored by the Toggl project color) flag which projects are in the group.

- **Am I tracking right now?** — a live status badge (this project / another
  project / not tracking).
- **How much have I tracked today?** — a big ring + live clock that ticks up in
  real time while a timer is running.
- **How much is left to a full day?** — remaining time toward your target.
- **Short Friday** — optional weekly model that front-loads the week so Friday
  is short.
- **Break reminder** — a prominent on-screen alert after 4.5h of continuous
  work.

It fills the whole screen with no scrolling.

## How it works

- **Next.js (App Router)**, deployable to Vercel in one click.
- Toggl's v9 API can't be called directly from a browser (CORS is whitelist-only
  and the whitelist call is itself blocked). So all Toggl calls go through a
  same-origin proxy route (`app/api/toggl/[...path]`) that adds Basic auth — no
  CORS setup, and your token never touches a third party.
- Your API token, selected project, and preferences live in the browser's
  `localStorage`.
- Alternatively, set a **`TOGGL_API_TOKEN`** env var for a private single-user
  deploy: the app detects it on load, connects automatically, and hides the
  token field in Settings (you only pick a project). A browser-entered token
  always takes precedence over the env var; the env var is the fallback used
  when no browser token is sent.

## Running locally

```bash
npm install
npm run dev      # http://localhost:3000
```

Then open Settings (⚙), paste your API token from
[track.toggl.com/profile](https://track.toggl.com/profile) (bottom of the page),
click **Connect**, pick your project, and optionally enable **Short Friday** or
adjust **Hours worked per week** (40h by default) for a part-time commitment.

## Deploying to Vercel

1. Push this repo to GitHub and import it in Vercel (framework auto-detected as
   Next.js — no extra config).
2. (Optional) Set `TOGGL_API_TOKEN` in Vercel's environment variables to skip
   entering the token in the UI. Otherwise the token stays in your browser.
3. (Optional) Set `APP_PASSWORD` to put the whole dashboard behind a password —
   see below.

## Install as an app (PWA)

The dashboard ships a web manifest, maskable icons, and Apple touch-icon /
status-bar metadata, so it can be installed to the home screen and launched
standalone (its own window, no browser chrome, dark theme color, safe-area
padding for notched phones). On the phone, "Add to Home Screen" (iOS Safari) or
the install prompt (Chrome / Android) does the job.

It is **not** offline-capable by design — a tiny pass-through service worker
(`public/sw.js`) only exists to satisfy installability and caches nothing, so the
app always shows live data and never serves anything stale.

## Password protection

A server-managed deploy (`TOGGL_API_TOKEN` set) is otherwise readable by anyone
who knows the URL. Set **`APP_PASSWORD`** to gate it:

- On first visit the app shows a password prompt; **no Toggl data is fetched or
  shown until the password is accepted.**
- The check is enforced **server-side** — the Toggl proxy refuses to serve the
  server token's data without a valid session — so it can't be bypassed by
  calling the API directly or editing the page.
- The **password is never stored** anywhere. On success the server returns a
  signed, expiring **session token**; the browser keeps only that token (in
  `localStorage`), so each device is asked for the password **at most once a
  week**.
- The session token is an HMAC signed with a key **derived from the password**,
  so **changing `APP_PASSWORD` instantly invalidates every existing session**.
- The gate only applies in server-managed mode. If `TOGGL_API_TOKEN` is unset,
  each user brings their own browser token and there's no shared secret to
  protect, so `APP_PASSWORD` has no effect.

Security notes:

- Use a **long, random** password and serve over **HTTPS** (Vercel is HTTPS by
  default) so neither the password nor the token can be sniffed.
- `localStorage` is readable by any JavaScript on the page; this app loads no
  third-party scripts, so the main residual risk is XSS. (An httpOnly cookie
  would be immune to that but can't be read by JS at all — `localStorage` is the
  deliberate, simple fit for this single-user tool.)
- A wrong-password guess is met with a small, escalating delay to slow brute
  force. This throttle is per server instance, so on a fanned-out serverless
  deploy it's best-effort — your password strength is the real defense.

## The targets model

The whole model aims for a configurable weekly total — **Hours worked per week**
in Settings, **40h** by default. Every figure below is the 40h-week baseline; set
the weekly hours lower (a part-time project) or higher and _all_ targets, floors
and caps rescale linearly. For example a **20h** week becomes an even **4h/day**,
or a short week of `4.5 / 4.5 / 4.5 / 4 / 2.5`. The break reminder is deliberately
**not** scaled (see below).

### Standard (Short Friday off)

A flat target every day of **week ÷ 5** (8h at 40h).

### Short Friday on (40h / week shown; scales with the weekly total)

| Day     | Target                                                                  |
| ------- | ----------------------------------------------------------------------- |
| Mon–Wed | **9h** each                                                             |
| **Thu** | `40h − (hours logged Mon–Wed) − 5h` — recalculated to leave ~5h for Fri |
| **Fri** | `40h − (hours logged Mon–Thu)` — simply whatever's left for the week    |
| Sat/Sun | 8h (fallback)                                                           |

Thursday and Friday adapt to what you actually logged earlier in the week, so an
over- or under-run mid-week is absorbed sensibly. Both are clamped to ≤ 12h (also
scaled).

### Advanced overrides

Two values under **Advanced targets** in Settings can be pinned independently of
the weekly figure. Each pre-fills with its proportional default; leave it blank to
keep auto-scaling, or type a value to fix it (it then stays put when you later
change the weekly hours):

- **Maximal individually billed timesheet** — the longest a single entry can be
  and still bill as one line (4h at 40h). Longer entries are flagged to split.
- **Minimal target working day** — the Friday floor: once the week is nearly done,
  the day's target never drops below this (5h at 40h), so a stray hour isn't worth
  a trip in. (The short-week Thursday reserve still scales purely with the weekly
  total, so the default shape is unchanged.)

Also under **Advanced** is **Round timesheet to** — the unit the timesheet rounds
each entry to. It defaults to **15 minutes (0.25h)**; pick **12 minutes (0.2h)**
for a client that can't bill quarter-hours. Only the timesheet and exports are
affected — the dashboard and the targets above are not.

### Don't bill overtime

Some engagements contractually disallow billing more than the agreed weekly hours.
Turn on **Don't bill overtime** (under **Advanced**) and the timesheet caps each
week's **billed** total at your **Hours worked per week**: when the week's billable
lines exceed the cap, it trims them back down — always **rounding down**, by whole
rounding units. The time is still tracked in Toggl; it just isn't billed.

How the trim is shared out:

- **`(X)`-marked time goes first.** Append `(X)` to a billing tag (e.g. `D123(X)`)
  to mark that time as the disposable buffer. `D123(X)` is treated as the *same
  billing code* as `D123` — they merge into one `D123` line — but the `(X)` share
  of that line is what gets trimmed first, and it can be trimmed all the way to
  zero before any firm time is touched.
- The cut is **spread proportionally** across the candidate lines and across the
  days of the week (the bigger the share, the more it gives up), so no single day
  or code is singled out.
- If trimming every `(X)` share still isn't enough to reach the cap, the firm
  remainder of the billable lines is trimmed the same way.

The **`(X)` marker is internal**: it's stripped from every displayed/exported code,
so a client never sees it. The cap is measured on **billable lines only** — the
"No billing tag" / "Multiple billing tags" / "Too long" warnings are problems to
fix in Toggl, not billable slack, so they never count toward it or get trimmed.

**Month boundaries split the cap.** Billing runs to month-end, so when the 1st of
a month falls mid-week the week is cut there and each side gets its own cap,
proportional to the **weekdays (Mon–Fri)** it holds — `weeklyHours / 5 × that
count` — and each side is trimmed independently. So if the 1st is a Wednesday, the
Sat–Tue half caps at `weeklyHours/5 × 2` and the Wed–Fri half at `weeklyHours/5 ×
3`. A weekend-only half caps at **zero** (its work isn't billed): when the 1st is a
Monday, the leading Sat–Sun is capped at nothing. A week wholly inside one month is
a single full-week segment capped at `weeklyHours`, exactly as before. This applies
to the on-screen week too, not just month exports.

The trimmed time is shown **only in the on-screen views** (Summary and Individual)
on a muted **"Overtime (not billed)"** line, as a hint that the cap is doing its
job. **Exports stay clean**: the XLSX / CSV / PDF contain only the billable
timesheet — no overtime line and no warning/overlap rows — and every billable
figure (and the totals) matches the view exactly.

## Break detection

You're reminded to take a break once you've worked **4.5h continuously** on the
selected project. A break is considered taken when either:

- there's a gap of **≥ 10 minutes** with no tracking, or
- you start tracking a **different project** (a context switch counts as a
  break).

Either resets the continuous-work timer. The alert can be snoozed for 15
minutes.

## Unreported time

The side panel flags **unreported time** — stretches of **today and yesterday**
where _no_ timer was running on _any_ project (a true hole in the timeline, as
opposed to a "Break", which here means working on a different project). It's
derived from the same week fetch, so it costs **no extra API calls**: entries
across all projects are merged and the gaps _between_ them are reported. Time
before your first entry or after your last isn't counted — only genuine gaps in
the middle. Gaps shorter than `UNREPORTED_MIN_MINUTES` (default **1 min**) are
ignored as noise.

The entries panel has **Today / Yesterday** tabs so you can see exactly where
each gap falls relative to your tracked work. Within the timeline a gap is drawn
as a **red dashed divider** (not a card), so it clearly reads as a hole rather
than another entry. A summary "Unreported time" card lists both days' gaps with
per-day totals.

## Billing tags

Every entry on the selected project is expected to carry a **billing tag** — a
Toggl tag whose name starts with a configurable prefix (default **`D`**, e.g.
`D123`) that says which line the time bills to.

- On the dashboard's **Today / Yesterday** timeline, any selected-project entry
  **missing** a billing tag gets a small ⚠ marker. It's deliberately a quiet,
  **non-amber** nudge — visible, but not alarming.
- It reads the tag names Toggl already returns on each time entry, so this costs
  **no extra API calls**.

The prefix is configurable under **Settings → Advanced → Billing tag prefix**
(change it to `A`, say, to match `A123` tags). Its default lives in
[`lib/calc.ts`](lib/calc.ts) as `DEFAULT_BILLING_TAG_PREFIX`.

## Workspaces (stored settings)

A **workspace** is a named snapshot of your settings you can recall in one click —
handy when you juggle more than one setup (different clients, each with their own
project selection, weekly target, billing-tag prefix and rounding).

- Configure the settings you want, then open **Settings → Workspaces**, type a
  name and hit **Save current**. Store as many as you like.
- Click a stored workspace in that list to **recall it instantly** — it switches
  live and the active one is marked. **↻** re-captures the current settings into
  it, **✎** renames, **🗑** deletes.
- Workspaces are **immutable snapshots**: editing your live settings never
  changes a stored one — recall a workspace to bring its settings back.

A workspace captures everything in Settings **except** the API token (the account
credential, shared across all workspaces) and the refresh interval (a per-device
knob). The list lives in the browser's `localStorage` alongside your other
settings — it's a secondary, tucked-away feature of the Settings panel.

## Timesheet

The **Timesheet** button (top-right of the dashboard, or `/timesheet`) opens a
copy-paste-ready view of the current week for filling in an external timesheet.
Which view it opens is chosen in **Settings → Timesheet view**:

- **Summary** (default) — the week combined per billing tag, described below.
- **Individual** — one row per entry, with times, described below.

Both views are built from the same single week fetch the dashboard already makes,
so they add **no API requests**.

### Previous weeks

Click **Previous weeks** (top-left of the timesheet) to step back in time. You
first get a plain **list of recent weeks** — choosing this list costs **no API
requests**. Only when you **select a week** is that week's data fetched (once),
and the chosen view renders it with the **same layout and warnings** as the live
current week.

A past week is a **frozen snapshot**: it does **not** auto-refresh. A **↻
Refresh** button re-fetches on demand, and — when the shared server cache is on —
deliberately **bypasses** it to pull genuinely live data. Already-fetched weeks
are kept **in memory for the session** (no `localStorage`), so re-opening one
costs nothing; reloading the page clears them. While you're viewing a past week
the live current-week poll is **paused**, so reading history never spends from
the hourly budget — it resumes when you click **This week**.

### Summary timesheet

- **Days are columns** (Mon–Fri always; Sat/Sun appear only when the project was
  tracked then) and **billing tags are rows**.
- Each day's entries for a tag are **combined into one cell**: their durations
  are summed and their descriptions merged (`; `-separated) with **duplicates
  removed**. Cells show **duration only** — no clock times.
- Durations are shown as **decimal hours** (e.g. `8.33h`) and **rounded to the
  nearest rounding unit** (15 minutes by default, or 12 — see Advanced above).
  The rounding is apportioned per day so each day's cells
  still **add up to that day's rounded total** — the error is spread evenly
  across tags rather than accumulating (largest-remainder method).
- A **copy button** on each cell copies that combined description to the
  clipboard. Per-day, per-tag, and grand-total hours are shown.
- An entry **without** a billing tag collects in a **"No billing tag"** row, and
  one carrying **more than one** billing tag collects in a **"Multiple billing
  tags"** row — both flagged in **amber** ⚠ so you go fix the tag in Toggl. These
  warning rows are **on-screen hints only**: they don't count toward the day/grand
  totals and never appear in exports (the totals are the billable lines alone, so
  the view and the export always agree).

### Individual timesheet

- The week is a **list of day sections**; each lists that day's entries on their
  own rows showing **start–end time, rounded hours, billing tag and description**
  (the summary view shows hours only). A **copy button** copies the row's
  description.
- **Times are rounded too:** each row's start is snapped to the nearest rounding
  unit and the end is start + the rounded duration, and rows are **packed
  forward so they never overlap** even after rounding.
- **Adjacent same-tag entries combine** into one row — but only when they sit
  **within an hour** of each other and the combined time stays **≤ 4h**. So
  `D-1, D-2, D-1` stays three rows, while the first two of `D-1, D-1, D-2, D-1`
  merge (unless that would exceed 4h, in which case they split).
- Rounding uses the same 15-minute, day-total-preserving method as the summary,
  with one tweak: it **biases small entries to surface** rather than vanish, and
  only drops a billable row if it _still_ rounds to zero.
- **Warnings** (amber): a **No billing tag** and **Multiple billing tags** row
  as in the summary, plus a **Too long to bill individually (> 4h)** row for any
  single entry over four hours (it can't be split), and an **Overlapping
  entries** notice when two entries overlap in time. The over-4h case also shows
  the same quiet ⚠ on the dashboard timeline. As in the summary, all of these are
  **view-only hints** — they don't count toward the totals and are left out of
  exports.

### Linked billing codes (subcontracting)

Sometimes a project is billed **through** another client: you work for a prime
contractor whose timesheet bills the whole engagement under **one** code, but the
work itself is tracked for a sub-client project with **its own** billing codes
and possibly its own rounding rules. **Settings → Advanced → Linked billing
codes** models exactly that. A linked code says, for one selected project:

- its entries carry the **sub-client's own tags** (a separate prefix, e.g. `S`
  for `S101`/`S102`), validated as usual — untagged or multi-tagged entries still
  land in the amber warning rows;
- per day, those entries are grouped by their own codes and rounded on the
  **mapping's own grid** (which must be this sheet's unit or a whole multiple of
  it, so figures stay tidy), exactly as the sub-client's own timesheet — a stored
  workspace with that prefix/rounding — would show them;
- the day's rounded total then bills on this sheet as the **single target code**
  you entered (e.g. `D-SUB-1`).

The guarantee that makes the two sheets reconcile: **per day, the sum of the
sub-client's billed codes equals this sheet's linked line** — by construction,
since the day-total-preserving rounding makes the sub-client's cells sum to the
rounded day total, and that same total is what the linked line carries. To keep
it, the linked line is treated as **fixed**: this sheet's own rounding pass never
re-rounds it and **"Don't bill overtime" never trims it** (it still counts
toward the weekly cap, so the trim takes correspondingly more off the native
lines). For traceability the cell's description leads with the sub-client's
per-code breakdown (e.g. `S101 1.75h, S102 0.50h`) followed by the merged entry
descriptions; in the Individual view the linked project appears as **one block
per day**, anchored at its first entry. Exports show the same figures as the
views, as always.

The mapping logic lives in [`lib/timesheet/mapping.ts`](lib/timesheet/mapping.ts).

Each view lives in its own component under
[`components/timesheet/`](components/timesheet); the page
([`app/timesheet/page.tsx`](app/timesheet/page.tsx)) is a thin shell that picks
one from a small registry, so adding a view is a component plus one entry.

## Staying within Toggl's rate limits

Toggl's **Free** plan allows only **30 API requests per hour** (per user, per
org; the `/me` endpoint has its own 30/hour budget). The app is built to stay
comfortably under that:

- **One request per refresh.** The week's time-entries call already includes the
  running timer, so there's no separate "current entry" call.
- **Cached connect.** Your workspace + project list are cached in `localStorage`
  for 24h, so reloading the page costs **zero** requests until the cache
  expires. (Click **Connect/Reconnect** in Settings to force a refresh.)
- **Configurable refresh interval**, default **3 minutes** (~20 requests/hour).
  Options range from 1 min (paid plans) to 10 min. The on-screen counter keeps
  ticking every second locally between refreshes, so the display stays live even
  at a slow interval.
- **Pauses when the tab is hidden** — no requests while you're not looking; it
  refreshes immediately when you return.
- **Backs off automatically** on a rate-limit response (HTTP 402/429),
  doubling the wait up to 15 minutes instead of hammering the API.
- **Live budget meter** in the footer shows an estimate of requests used in the
  last hour (turns amber near the limit).

> Tip: if you open the dashboard in several tabs/devices at once, they each spend
> from the same hourly budget — keep one open, raise the interval, or enable the
> shared server cache below.

## Shared server-side cache (multi-device)

If you want to keep the dashboard open on **several devices** (desk monitor,
laptop, phone…) without each one independently burning through Toggl's 30/hour
budget, set the **`TOGGL_CACHE_INTERVAL`** env var (requires `TOGGL_API_TOKEN`,
since the cache is keyed to the server's own token).

When it's set:

- Every device's poll is served from a **shared in-process cache**
  (`lib/serverCache.ts`) sitting behind the proxy. Only the **first** poll after
  the cache goes stale actually calls Toggl; the rest read the cached payload.
  So total upstream usage is **~one request per interval regardless of how many
  devices are watching**.
- It's **lazy / demand-driven** — there is no background timer. The cache only
  refreshes when a request arrives and finds it stale, so **an idle dashboard
  (nobody looking) makes zero requests.**
- Concurrent polls are **de-duplicated** (single-flight): three devices hitting
  it at the same instant cause exactly one Toggl call.
- On a transient error or rate-limit, the last good payload is **served stale**
  rather than blanking the screen.
- The front-end's per-device **Refresh interval** picker is **hidden**, and the
  app polls at the server-driven interval instead. The footer shows
  "Shared server cache · refreshes every Nmin across all devices."

The value is the refresh interval in **seconds**. Since the Free plan allows 30
requests/hour, keep it **≥ 120** (one request per 120 s = 30/hr); the default
when you set it to `true` is **180** (~20/hr, leaving headroom for the one-off
`me`/projects connect calls). Setting it to `1`/`true`/`on` uses that default;
a number sets an explicit interval (clamped to a 30 s minimum).

> The cache is **in-memory, per server instance** — the right, simplest fit for
> this private single-user app, where traffic is tiny and a single long-running
> server (`next start`, or a warm Vercel instance) backs every request. On a
> heavily fan-out serverless deployment with many cold instances it degrades
> gracefully to best-effort (each instance keeps its own cache), never worse
> than the un-cached behavior.

## Tunable constants

The workload thresholds live at the top of [`lib/calc.ts`](lib/calc.ts) as
private `BASE_*` values tuned for a **40h** baseline (`BASELINE_WEEKLY_HOURS`).
They are read through `resolveTargets(cfg)`, which scales each one by
`weeklyHours / 40` from the user's `WeekConfig` (weekly hours plus the two
optional overrides). The Friday floor and the billable cap resolve through
`effectiveMinWorkingDayHours` / `effectiveMaxBillableHours` (override if set,
else the proportional default).

The fixed, deliberately **un-scaled** thresholds stay exported:
`BREAK_AFTER_HOURS` (ergonomic — same regardless of the week's size),
`BREAK_GAP_MINUTES`, and `UNREPORTED_MIN_MINUTES`. The timesheet's rounding
granularity defaults to `QUARTER_SECONDS` (15 min) but is a user setting
(`roundingHours`); `roundingUnitSeconds` converts it to seconds for the builders.
