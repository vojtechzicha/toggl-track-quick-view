# toggl-track-quick-view

A single-screen quick view for tracking your work day on **one** Toggl Track
client/project. Open it on a spare monitor and see, at a glance:

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
click **Connect**, pick your project, and optionally enable **Short Friday**.

## Deploying to Vercel

1. Push this repo to GitHub and import it in Vercel (framework auto-detected as
   Next.js — no extra config).
2. (Optional) Set `TOGGL_API_TOKEN` in Vercel's environment variables to skip
   entering the token in the UI. Otherwise the token stays in your browser.
3. (Optional) Set `APP_PASSWORD` to put the whole dashboard behind a password —
   see below.

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

### Standard (Short Friday off)

A flat **8h** target every day.

### Short Friday on (40h / week)

| Day     | Target                                                                  |
| ------- | ----------------------------------------------------------------------- |
| Mon–Wed | **9h** each                                                             |
| **Thu** | `40h − (hours logged Mon–Wed) − 5h` — recalculated to leave ~5h for Fri |
| **Fri** | `40h − (hours logged Mon–Thu)` — simply whatever's left for the week    |
| Sat/Sun | 8h (fallback)                                                           |

Thursday and Friday adapt to what you actually logged earlier in the week, so an
over- or under-run mid-week is absorbed sensibly. Both are clamped to ≤ 12h.

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

All thresholds live at the top of [`lib/calc.ts`](lib/calc.ts):
`WEEKLY_HOURS`, `MIDWEEK_TARGET_HOURS`, `DESIRED_FRIDAY_HOURS`,
`BREAK_AFTER_HOURS`, `BREAK_GAP_MINUTES`, `UNREPORTED_MIN_MINUTES`, etc.
