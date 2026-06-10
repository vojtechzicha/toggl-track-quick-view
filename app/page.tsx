'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import ProgressRing from '@/components/ProgressRing';
import SettingsPanel from '@/components/SettingsPanel';
import ProjectChips from '@/components/ProjectChips';
import PasswordGate from '@/components/PasswordGate';
import { useToggl, HOURLY_LIMIT, fmtInterval } from '@/lib/useToggl';
import {
  NormEntry,
  Gap,
  normalize,
  projectSecondsInRange,
  scheduledLaterSeconds,
  coveringEntry,
  dailyTargetSeconds,
  plannedTargetSeconds,
  continuousWorkSeconds,
  unreportedGaps,
  mergeIntervals,
  subtractIntervals,
  hasBillingTag,
  startOfDay,
  startOfWeek,
  fmtHM,
  fmtClock,
  fmtTimeOfDay,
  fmtHoursLabel,
  BREAK_AFTER_HOURS,
  effectiveMaxBillableHours,
} from '@/lib/calc';

const SNOOZE_MS = 15 * 60_000;

export default function Page() {
  const t = useToggl();
  const {
    hydrated,
    settings,
    persist,
    projects,
    serverManaged,
    passwordRequired,
    authed,
    pwError,
    pwBusy,
    submitPassword,
    ready,
    connecting,
    authError,
    fetchError,
    connect,
    entries,
    nowMs,
    reqThisHour,
    cacheEnabled,
    effectiveRefreshSec,
    showSettings,
    setShowSettings,
  } = t;

  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const [dayTab, setDayTab] = useState<'today' | 'yesterday'>('today');

  // The selected projects together count as "the project". The set drives every
  // tracking/target calculation (they're indistinguishable there); the array keeps
  // names/colors for the header chips and the running-entry label.
  const sel = settings.selectedProjects;
  const multi = sel.length > 1;
  const projectIds = useMemo(() => new Set(sel.map((p) => p.id)), [sel]);
  const nameOf = (id: number | null) =>
    id != null ? sel.find((p) => p.id === id)?.name ?? '' : '';

  // After a successful connection, prompt for a project if none is chosen yet.
  useEffect(() => {
    if (ready && projectIds.size === 0) setShowSettings(true);
  }, [ready, projectIds, setShowSettings]);

  const view = useMemo(() => {
    if (projectIds.size === 0 || !nowMs) return null;
    const norm = normalize(entries, nowMs);
    const inSel = (id: number | null) => id != null && projectIds.has(id);
    const now = new Date(nowMs);
    const dayStart = startOfDay(now).getTime();
    const dayEnd = dayStart + 24 * 3600 * 1000;

    const trackedToday = projectSecondsInRange(norm, projectIds, dayStart, nowMs);
    const target = dailyTargetSeconds(now, norm, projectIds, settings.shortFriday, settings);
    const remaining = Math.max(0, target - trackedToday);
    const fraction = target > 0 ? trackedToday / target : 1;

    // Time you've scheduled for later today: counts toward the day's target but is
    // not yet worked, so it lets you stop the live work sooner. The ring is left
    // alone (worked time only); only the live work still required shrinks.
    const scheduledLater = scheduledLaterSeconds(norm, projectIds, nowMs, dayEnd);
    const remainingLive = Math.max(0, remaining - scheduledLater);
    const leaveAtMs = remainingLive > 0 ? nowMs + remainingLive * 1000 : null;
    const coveredByScheduled = remaining > 0 && remainingLive <= 0;

    const runningEntry = norm.find((e) => e.running) ?? null;
    const trackingProject = !!runningEntry && inSel(runningEntry.projectId);
    const trackingOther = !!runningEntry && !inSel(runningEntry.projectId);
    const covering = !runningEntry ? coveringEntry(norm, projectIds, nowMs) : null;
    const onPlan = !!covering;
    const coveringRaw = covering ? entries.find((e) => e.id === covering.id) ?? null : null;
    const coveringDesc = coveringRaw?.description?.trim() || '';
    const coveringEndsMs = covering?.stopMs ?? null;
    const coveringCountdown = covering ? Math.max(0, (covering.stopMs - nowMs) / 1000) : 0;
    const otherLabel = trackingOther ? (remaining <= 0 ? 'No tracking' : 'Break') : '';
    const runningRaw = entries.find((e) => e.duration < 0 || !e.stop) ?? null;
    const currentDescription = runningRaw?.description?.trim() || '';
    const currentSeconds = runningRaw
      ? Math.max(0, (nowMs - new Date(runningRaw.start).getTime()) / 1000)
      : 0;

    const cont = continuousWorkSeconds(norm, projectIds, nowMs);
    const breakDue = cont.working && cont.seconds >= BREAK_AFTER_HOURS * 3600;
    const timeToBreak = cont.working ? Math.max(0, BREAK_AFTER_HOURS * 3600 - cont.seconds) : 0;
    const breakAtMs = cont.working && !breakDue ? nowMs + timeToBreak * 1000 : null;

    const candidates: { kind: 'break' | 'leave'; at: number }[] = [];
    if (breakAtMs) candidates.push({ kind: 'break', at: breakAtMs });
    if (leaveAtMs) candidates.push({ kind: 'leave', at: leaveAtMs });
    candidates.sort((a, b) => a.at - b.at);
    const nextMilestone = candidates[0] ?? null;

    return {
      trackedToday,
      target,
      remaining,
      fraction,
      leaveAtMs,
      scheduledLater,
      remainingLive,
      coveredByScheduled,
      trackingProject,
      trackingOther,
      otherLabel,
      onPlan,
      runningProjectId: runningEntry?.projectId ?? null,
      coveringProjectId: covering?.projectId ?? null,
      coveringDesc,
      coveringEndsMs,
      coveringCountdown,
      currentDescription,
      currentSeconds,
      continuous: cont.seconds,
      working: cont.working,
      breakDue,
      breakAtMs,
      nextMilestone,
    };
  }, [
    entries,
    nowMs,
    projectIds,
    settings.shortFriday,
    settings.weeklyHours,
    settings.minWorkingDayHours,
  ]);

  // Day timelines for the side panel (no extra API calls — both days come from
  // the same week fetch). Selected-project entries are listed individually and
  // flagged when they lack a billing tag; other-project time collapses into a
  // single "Break" block, and genuine unreported gaps are interleaved.
  type TLItem = {
    key: string;
    kind: 'project' | 'scheduled' | 'break' | 'unreported';
    desc: string;
    startMs: number;
    stopMs: number;
    running: boolean;
    dur: number;
    missingTag: boolean;
    tooLong: boolean;
    projId: number | null;
  };
  const timelines = useMemo(() => {
    const empty = { today: [] as TLItem[], yesterday: [] as TLItem[] };
    if (!nowMs) return empty;
    const norm = normalize(entries, nowMs);
    const dayMs = 24 * 3600 * 1000;
    const maxBillSec = effectiveMaxBillableHours(settings) * 3600;

    const build = (dayStart: number, isToday: boolean): TLItem[] => {
      const dayEnd = dayStart + dayMs;
      const liveCap = isToday ? Math.min(nowMs, dayEnd) : dayEnd;
      const dayEntries = entries
        .map((e) => {
          const startMs = new Date(e.start).getTime();
          const running = e.duration < 0 || !e.stop;
          const rawStop = running ? nowMs : new Date(e.stop as string).getTime();
          return {
            id: e.id,
            desc: e.description?.trim() || '(no description)',
            projectId: e.project_id,
            tags: e.tags,
            startMs,
            stopMs: Math.min(rawStop, dayEnd), // clip a day-crossing entry to the day
            running: running && isToday,
          };
        })
        .filter((e) => e.startMs >= dayStart && e.startMs < dayEnd)
        .sort((a, b) => a.startMs - b.startMs);

      const items: TLItem[] = [];

      const inSel = (id: number | null) => id != null && projectIds.has(id);
      const projectCoverage = mergeIntervals(
        dayEntries
          .filter((e) => inSel(e.projectId))
          .map((e) => ({ a: e.startMs, b: e.stopMs }))
      );
      for (const e of dayEntries) {
        if (!inSel(e.projectId)) continue;
        const scheduled = !e.running && e.stopMs > liveCap;
        const dur = Math.max(0, (e.stopMs - e.startMs) / 1000);
        items.push({
          key: `e${e.id}`,
          kind: scheduled ? 'scheduled' : 'project',
          desc: e.desc,
          startMs: e.startMs,
          stopMs: e.stopMs,
          running: e.running,
          dur,
          missingTag: !hasBillingTag(e.tags, settings.billingTagPrefix),
          tooLong: dur > maxBillSec,
          projId: e.projectId,
        });
      }

      const breakSpans = subtractIntervals(
        dayEntries
          .filter((e) => !inSel(e.projectId))
          .map((e) => ({ a: e.startMs, b: Math.min(e.stopMs, liveCap) })),
        projectCoverage
      );
      for (const b of breakSpans) {
        if (b.b - b.a < 60_000) continue;
        items.push({
          key: `b${b.a}`,
          kind: 'break',
          desc: 'Break',
          startMs: b.a,
          stopMs: b.b,
          running: isToday && b.b >= liveCap,
          dur: (b.b - b.a) / 1000,
          missingTag: false,
          tooLong: false,
          projId: null,
        });
      }

      for (const g of unreportedGaps(norm, dayStart, liveCap)) {
        items.push({
          key: `u${g.startMs}`,
          kind: 'unreported',
          desc: 'Unreported',
          startMs: g.startMs,
          stopMs: g.stopMs,
          running: false,
          dur: g.seconds,
          missingTag: false,
          tooLong: false,
          projId: null,
        });
      }

      items.sort((a, b) => a.startMs - b.startMs);
      return items.reverse(); // newest first
    };

    const todayStart = startOfDay(new Date(nowMs)).getTime();
    const yesterdayStart = todayStart - dayMs;
    return {
      today: build(todayStart, true),
      yesterday: build(yesterdayStart, false),
    };
  }, [
    entries,
    nowMs,
    projectIds,
    settings.weeklyHours,
    settings.maxBillableHours,
    settings.billingTagPrefix,
  ]);

  // Week summary for the side panel: logged vs target for each weekday. Mon–Fri
  // always show; Sat/Sun appear only when the selected project was tracked then.
  const weekSummary = useMemo(() => {
    if (projectIds.size === 0 || !nowMs) return null;
    const norm = normalize(entries, nowMs);
    const repId = [...projectIds][0]; // a representative project for the projection
    const dayMs = 24 * 3600 * 1000;
    const weekStart = startOfWeek(new Date(nowMs)).getTime();
    const todayStart = startOfDay(new Date(nowMs)).getTime();
    const beforeThursday = new Date(nowMs).getDay() < 4; // Mon–Wed (Sun=0 counts as before)

    const todayTarget = dailyTargetSeconds(
      new Date(todayStart),
      norm,
      projectIds,
      settings.shortFriday,
      settings
    );
    const todayLogged = projectSecondsInRange(norm, projectIds, todayStart, nowMs);
    const shortfall = Math.max(0, todayTarget - todayLogged);
    const projected: NormEntry[] =
      shortfall > 0
        ? [
            ...norm,
            {
              id: -1,
              startMs: todayStart,
              stopMs: todayStart + shortfall * 1000,
              projectId: repId,
              running: false,
            },
          ]
        : norm;

    const days: {
      key: number;
      label: string;
      logged: number;
      scheduled: number;
      target: number;
      met: boolean;
      onTrack: boolean;
    }[] = [];
    for (let i = 0; i < 7; i++) {
      const dayStart = weekStart + i * dayMs;
      const dayEnd = dayStart + dayMs;
      const date = new Date(dayStart);
      const isWeekend = date.getDay() === 6 || date.getDay() === 0; // Sat/Sun
      const logged = projectSecondsInRange(norm, projectIds, dayStart, Math.min(dayEnd, nowMs));
      const scheduled = projectSecondsInRange(norm, projectIds, Math.max(dayStart, nowMs), dayEnd);
      if (isWeekend && logged === 0 && scheduled === 0) continue; // hide untouched weekend days
      const isFuture = dayStart > todayStart;
      const target =
        isFuture && beforeThursday
          ? plannedTargetSeconds(date.getDay(), settings.shortFriday, settings)
          : dailyTargetSeconds(
              date,
              isFuture ? projected : norm,
              projectIds,
              settings.shortFriday,
              settings
            );
      days.push({
        key: dayStart,
        label: date.toLocaleDateString(undefined, { weekday: 'short' }),
        logged,
        scheduled,
        target,
        met: logged >= target,
        onTrack: logged + scheduled >= target,
      });
    }
    const totalLogged = days.reduce((s, d) => s + d.logged, 0);
    const totalScheduled = days.reduce((s, d) => s + d.scheduled, 0);
    return { days, totalLogged, totalScheduled, projected: totalLogged + totalScheduled };
  }, [
    entries,
    nowMs,
    projectIds,
    settings.shortFriday,
    settings.weeklyHours,
    settings.minWorkingDayHours,
  ]);

  // Unreported time (no entry at all) for the side card — today and yesterday.
  const unreported = useMemo(() => {
    if (!nowMs) return null;
    const norm = normalize(entries, nowMs);
    const todayStart = startOfDay(new Date(nowMs)).getTime();
    const yesterdayStart = todayStart - 24 * 3600 * 1000;
    const today = unreportedGaps(norm, todayStart, nowMs);
    const yesterday = unreportedGaps(norm, yesterdayStart, todayStart);
    const sum = (gs: Gap[]) => gs.reduce((s, g) => s + g.seconds, 0);
    return { today, yesterday, todayTotal: sum(today), yestTotal: sum(yesterday) };
  }, [entries, nowMs]);

  const showBreakAlert = !!view?.breakDue && nowMs > snoozeUntil;

  const ringColor = !view
    ? 'var(--accent)'
    : showBreakAlert
    ? 'var(--amber)'
    : view.remaining <= 0
    ? 'var(--green)'
    : view.trackingProject
    ? 'var(--accent)'
    : 'var(--accent-soft)';

  // ---- Render ----
  if (!hydrated) {
    return <div className="center-msg">Loading…</div>;
  }

  const needsPassword = serverManaged === true && passwordRequired && !authed;

  const done = view ? view.remaining <= 0 : false;
  const maxBillableLabel = fmtHoursLabel(effectiveMaxBillableHours(settings));
  const timeline = dayTab === 'today' ? timelines.today : timelines.yesterday;
  const budgetClass =
    reqThisHour >= HOURLY_LIMIT ? 'over' : reqThisHour >= HOURLY_LIMIT - 6 ? 'warn' : '';

  return (
    <>
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <h1>
              {multi
                ? settings.groupName || 'Toggl Quick View'
                : sel[0]?.name || 'Toggl Quick View'}
              {multi && <ProjectChips projects={sel} className="chips-inline" />}
            </h1>
            <p>
              {settings.shortFriday ? 'Short week' : 'Regular week'} ·{' '}
              {fmtHoursLabel(settings.weeklyHours)} goal
              {' · '}
              {new Date(nowMs || Date.now()).toLocaleDateString(undefined, {
                weekday: 'long',
              })}
            </p>
          </div>
          <div className="topbar-actions">
            <Link className="navbtn" href="/timesheet" aria-label="Timesheet">
              <span className="navbtn-icon">🧾</span>
              <span className="navbtn-text">Timesheet</span>
            </Link>
            <button
              className="iconbtn"
              aria-label="Settings"
              onClick={() => setShowSettings(true)}
            >
              ⚙
            </button>
          </div>
        </header>

        {showBreakAlert && (
          <div className="breakbar" role="alert">
            <span>☕</span>
            <span className="grow">
              You&apos;ve worked {fmtHM(view!.continuous)} straight — time for a break.
            </span>
            <button onClick={() => setSnoozeUntil(Date.now() + SNOOZE_MS)}>Snooze 15m</button>
          </div>
        )}

        <div className="main">
          <div className="stage">
            {view ? (
              <>
                <StatusBadge view={view} />

                <ProgressRing
                  fraction={view.fraction}
                  color={ringColor}
                  projectedFraction={
                    view.target > 0
                      ? (view.trackedToday + view.scheduledLater) / view.target
                      : 1
                  }
                  scheduledColor="var(--accent-soft)"
                >
                  <div className="clock">{fmtClock(view.trackedToday)}</div>
                  <div className="pct">{Math.round(view.fraction * 100)}%</div>
                  <div className="of">
                    of {fmtHM(view.target)} target
                    {view.scheduledLater > 0 && (
                      <span className="of-sched"> · +{fmtHM(view.scheduledLater)} scheduled</span>
                    )}
                  </div>
                </ProgressRing>

                {view.nextMilestone ? (
                  <div className={`next-time ${view.nextMilestone.kind}`}>
                    {view.nextMilestone.kind === 'break' ? '☕ Break at ' : '🏁 Leave at '}
                    <strong>{fmtTimeOfDay(view.nextMilestone.at)}</strong>
                    {view.nextMilestone.kind === 'leave' && view.scheduledLater > 0 && (
                      <span className="sched-note"> · {fmtHM(view.scheduledLater)} scheduled later</span>
                    )}
                  </div>
                ) : view.coveredByScheduled ? (
                  <div className="next-time leave">
                    🏁 You can leave now
                    <span className="sched-note"> · {fmtHM(view.scheduledLater)} scheduled later</span>
                  </div>
                ) : (
                  <div className="next-time done">🎉 Target reached — you can leave</div>
                )}

                <div className="stats">
                  <div className="stat">
                    <div className="label">Tracked today</div>
                    <div className="value">{fmtHM(view.trackedToday)}</div>
                  </div>
                  <div className="stat">
                    <div className="label">{done ? 'Over target' : 'Remaining'}</div>
                    <div className={`value ${done ? 'green' : ''}`}>
                      {done ? `+${fmtHM(view.trackedToday - view.target)}` : fmtHM(view.remaining)}
                    </div>
                    {!done && view.scheduledLater > 0 && (
                      <div className="value-sub">
                        {fmtHM(view.scheduledLater)} scheduled · {fmtHM(view.remainingLive)} to work
                      </div>
                    )}
                  </div>
                  <div className="stat">
                    <div className="label">Continuous</div>
                    <div className={`value ${showBreakAlert ? 'amber' : ''}`}>
                      {view.working ? fmtHM(view.continuous) : '—'}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="center-msg" style={{ height: 'auto' }}>
                {settings.token || serverManaged
                  ? 'Pick a project in settings to begin.'
                  : 'Connect Toggl to begin.'}
              </div>
            )}
          </div>

          {view && (
            <aside className="side">
              <div className="side-card">
                <div className="side-title">Currently tracking</div>
                {view.trackingProject ? (
                  <>
                    <div className="now-desc">
                      {view.currentDescription || '(no description)'}
                    </div>
                    <div className="now-meta">
                      {nameOf(view.runningProjectId) || sel[0]?.name || ''}
                    </div>
                    <div className="now-time">{fmtClock(view.currentSeconds)}</div>
                  </>
                ) : view.onPlan ? (
                  <>
                    <div className="now-desc">{view.coveringDesc || '(no description)'}</div>
                    <div className="now-meta">
                      {nameOf(view.coveringProjectId) || sel[0]?.name || ''} · on plan
                      {view.coveringEndsMs ? ` · ends ${fmtTimeOfDay(view.coveringEndsMs)}` : ''}
                    </div>
                    <div className="now-time plan">{fmtClock(view.coveringCountdown)} left</div>
                  </>
                ) : view.trackingOther ? (
                  <div className="now-idle">{view.otherLabel}</div>
                ) : (
                  <div className="now-idle">Nothing running</div>
                )}
              </div>

              {unreported &&
                (unreported.today.length > 0 || unreported.yesterday.length > 0) && (
                  <div className="side-card unrep-card">
                    <div className="side-title">Unreported time</div>
                    <UnreportedGroup
                      label="Today"
                      gaps={unreported.today}
                      total={unreported.todayTotal}
                    />
                    <UnreportedGroup
                      label="Yesterday"
                      gaps={unreported.yesterday}
                      total={unreported.yestTotal}
                    />
                  </div>
                )}

              {weekSummary && weekSummary.days.length > 0 && (
                <div className="side-card week-card">
                  <div className="side-title">This week</div>
                  {weekSummary.totalScheduled > 0 && (
                    <div className="week-proj">
                      <div className="week-proj-main">
                        Projected <strong>{fmtHM(weekSummary.projected)}</strong> /{' '}
                        {fmtHoursLabel(settings.weeklyHours)}
                      </div>
                      <div className="week-proj-sub">
                        <span>{fmtHM(weekSummary.totalLogged)} worked</span>
                        <span> · {fmtHM(weekSummary.totalScheduled)} scheduled</span>
                      </div>
                    </div>
                  )}
                  <div className="week-list">
                    {weekSummary.days.map((d) => (
                      <div key={d.key} className="week-row">
                        <span className="week-day">{d.label}</span>
                        <span className="week-vals">
                          <span className={`week-logged ${d.met ? 'met' : ''}`}>
                            {d.logged > 0 || d.scheduled === 0 ? fmtHM(d.logged) : '—'}
                          </span>
                          {d.scheduled > 0 && (
                            <span className={`week-sched ${d.onTrack ? 'on-track' : ''}`}>
                              {' '}
                              +{fmtHM(d.scheduled)}
                            </span>
                          )}
                          <span className="week-sep">/</span>
                          <span className="week-target">{fmtHM(d.target)}</span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="side-card history-card">
                <div className="day-tabs" role="tablist">
                  <button
                    role="tab"
                    aria-selected={dayTab === 'today'}
                    className={`day-tab ${dayTab === 'today' ? 'active' : ''}`}
                    onClick={() => setDayTab('today')}
                  >
                    Today
                  </button>
                  <button
                    role="tab"
                    aria-selected={dayTab === 'yesterday'}
                    className={`day-tab ${dayTab === 'yesterday' ? 'active' : ''}`}
                    onClick={() => setDayTab('yesterday')}
                  >
                    Yesterday
                  </button>
                </div>
                <div className="history-list">
                  {timeline.length === 0 ? (
                    <div className="now-idle">
                      {dayTab === 'today' ? 'No entries yet today' : 'No entries yesterday'}
                    </div>
                  ) : (
                    timeline.map((h) =>
                      h.kind === 'unreported' ? (
                        <div key={h.key} className="gap-marker">
                          <span className="gap-text">
                            ⚠ {fmtHM(h.dur)} unreported · {fmtTimeOfDay(h.startMs)}–
                            {fmtTimeOfDay(h.stopMs)}
                          </span>
                        </div>
                      ) : (
                        <div
                          key={h.key}
                          className={`hist-item ${h.running ? 'live' : ''} ${
                            h.kind === 'break' ? 'brk' : ''
                          } ${h.kind === 'scheduled' ? 'sched' : ''}`}
                        >
                          <div className="hist-top">
                            <span className="hist-desc">
                              {h.kind === 'break'
                                ? '☕ Break'
                                : h.kind === 'scheduled'
                                ? `📅 ${h.desc}`
                                : h.desc}
                            </span>
                            {multi && h.projId != null && (
                              <ProjectChips projects={sel.filter((p) => p.id === h.projId)} />
                            )}
                            {h.missingTag && (
                              <span
                                className="tag-warn"
                                title="No billing tag — add one in Toggl"
                              >
                                ⚠
                              </span>
                            )}
                            {h.tooLong && (
                              <span
                                className="tag-warn"
                                title={`Longer than ${maxBillableLabel} — can't be billed individually; split it in Toggl`}
                              >
                                ⚠
                              </span>
                            )}
                            <span className="hist-dur">{fmtHM(h.dur)}</span>
                          </div>
                          <div className="hist-bottom">
                            <span className="hist-time">
                              {fmtTimeOfDay(h.startMs)}–
                              {h.running ? 'now' : fmtTimeOfDay(h.stopMs)}
                            </span>
                          </div>
                        </div>
                      )
                    )
                  )}
                </div>
              </div>
            </aside>
          )}
        </div>

        <footer className="footer">
          {fetchError ? (
            <span className="err">{fetchError}</span>
          ) : cacheEnabled ? (
            <span>
              Shared server cache · refreshes every {fmtInterval(effectiveRefreshSec)} across all
              devices
            </span>
          ) : (
            <span>Refreshes every {fmtInterval(settings.refreshSec)} · live counter each second</span>
          )}
          {!cacheEnabled && (
            <span className={`budget ${budgetClass}`}>
              {' · '}≈{reqThisHour}/{HOURLY_LIMIT} API requests this hour
            </span>
          )}
        </footer>
      </div>

      {needsPassword && (
        <PasswordGate onSubmit={submitPassword} error={pwError} busy={pwBusy} />
      )}

      {!needsPassword && showSettings && (
        <SettingsPanel
          initial={{
            token: settings.token,
            selectedProjects: settings.selectedProjects,
            groupName: settings.groupName,
            shortFriday: settings.shortFriday,
            weeklyHours: settings.weeklyHours,
            maxBillableHours: settings.maxBillableHours,
            minWorkingDayHours: settings.minWorkingDayHours,
            billingTagPrefix: settings.billingTagPrefix,
            roundingHours: settings.roundingHours,
            refreshSec: settings.refreshSec,
            timesheetMode: settings.timesheetMode,
            exportName: settings.exportName,
          }}
          projects={projects}
          serverManaged={!!serverManaged}
          cacheInterval={cacheEnabled ? effectiveRefreshSec : null}
          authError={authError}
          connecting={connecting}
          onConnect={(token) => connect(token, true)}
          onSave={(v) => {
            persist({ ...settings, ...v });
            setShowSettings(false);
          }}
          onClose={() => setShowSettings(false)}
          canClose={projectIds.size > 0}
        />
      )}
    </>
  );
}

function UnreportedGroup({
  label,
  gaps,
  total,
}: {
  label: string;
  gaps: Gap[];
  total: number;
}) {
  return (
    <div className="unrep-group">
      <div className="unrep-head">
        <span>{label}</span>
        <span className={total > 0 ? 'amber' : 'ok'}>
          {total > 0 ? fmtHM(total) : '✓ all reported'}
        </span>
      </div>
      {gaps.map((g) => (
        <div key={g.startMs} className="unrep-row">
          <span className="unrep-time">
            {fmtTimeOfDay(g.startMs)}–{fmtTimeOfDay(g.stopMs)}
          </span>
          <span className="unrep-dur">{fmtHM(g.seconds)}</span>
        </div>
      ))}
    </div>
  );
}

function StatusBadge({
  view,
}: {
  view: {
    trackingProject: boolean;
    trackingOther: boolean;
    otherLabel: string;
    onPlan: boolean;
    remaining: number;
    remainingLive: number;
    scheduledLater: number;
    trackedToday: number;
    target: number;
  };
}) {
  if (view.trackingProject) {
    // Worked past the target itself — genuine overtime.
    if (view.remaining <= 0 && view.target > 0) {
      return (
        <span className="badge live overtime">
          <span className="dot" /> 🏁 Over target · +{fmtHM(view.trackedToday - view.target)} overtime
        </span>
      );
    }
    // Not over by worked time, but your scheduled-later blocks already cover the
    // rest of the target — you can leave now even though a break is still queued.
    if (view.remainingLive <= 0 && view.target > 0) {
      return (
        <span className="badge live ready">
          <span className="dot" /> 🏁 Ready to leave
          {view.scheduledLater > 0 && ` · ${fmtHM(view.scheduledLater)} scheduled later`}
        </span>
      );
    }
    return (
      <span className="badge live">
        <span className="dot" /> Tracking now
      </span>
    );
  }
  if (view.onPlan) {
    return (
      <span className="badge plan">
        <span className="dot" /> 📅 On plan
      </span>
    );
  }
  if (view.trackingOther) {
    return (
      <span className="badge other">
        <span className="dot" /> {view.otherLabel}
      </span>
    );
  }
  return (
    <span className="badge">
      <span className="dot" /> Not tracking
    </span>
  );
}
