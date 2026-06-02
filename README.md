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
> from the same hourly budget — keep one open, or raise the interval.

## Tunable constants

All thresholds live at the top of [`lib/calc.ts`](lib/calc.ts):
`WEEKLY_HOURS`, `MIDWEEK_TARGET_HOURS`, `DESIRED_FRIDAY_HOURS`,
`BREAK_AFTER_HOURS`, `BREAK_GAP_MINUTES`, etc.
