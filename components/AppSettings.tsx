'use client';

// The one place SettingsPanel is wired to the track source. All three pages
// (dashboard, timesheet, tracker) render the same settings surface; this
// wrapper owns the mapping so they can't drift — most importantly the
// standalone branch, where the panel's "Workspaces" section manages server
// documents (create/recapture/rename/recolor/delete) instead of the
// localStorage preset list, and stored workspaces double as the selectable
// "projects".

import { useEffect, useState } from 'react';
import SettingsPanel, { type SettingsPreset } from '@/components/SettingsPanel';
import { applyPreset, type UseTrackSource } from '@/lib/useTrackSource';

export default function AppSettings({
  t,
  canClose,
  openWorkspaces = false,
}: {
  t: UseTrackSource;
  canClose: boolean;
  // Opened from the topbar switcher's "Manage workspaces…": land on that
  // section rather than at the top of the form.
  openWorkspaces?: boolean;
}) {
  const { settings, persist, projects, mode } = t;
  const standalone = mode === 'standalone';

  // The panel's form snapshots `settings` once on mount. When something
  // replaces the settings underneath it, the form must re-seed or its next
  // Save would clobber what was just applied — remounting on a changed key is
  // what re-seeds it, and the notice tells the user why the fields moved.
  //
  // Two sources: a settings-file import (formEpoch, bumped by the wiring
  // below) and a document adopted from another device — a background pull or a
  // conflict resolved in its favour — which the hook counts for us. The pull
  // arrives with no user action at all, so nothing else would catch it.
  const [formEpoch, setFormEpoch] = useState(0);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const appliedEpoch = t.sync.appliedEpoch;
  const [seenAppliedEpoch, setSeenAppliedEpoch] = useState(appliedEpoch);
  useEffect(() => {
    if (appliedEpoch === seenAppliedEpoch) return;
    setSeenAppliedEpoch(appliedEpoch);
    setSyncNotice('Settings from another device arrived — the fields below now show them.');
  }, [appliedEpoch, seenAppliedEpoch]);

  // In standalone mode the panel lists the server's workspaces where Toggl mode
  // shows localStorage presets — same shape, different storage.
  const presets: SettingsPreset[] = standalone
    ? t.workspaces.map((w) => ({
        id: String(w.id),
        name: w.name,
        color: w.color,
        value: w.settings,
      }))
    : settings.presets;

  // The workspace the current settings mirror (the "active" row in the panel's
  // list) — excluded from the linked-codes picker: a workspace can't bill onto
  // its own timesheet as a linked code. The hook resolves it by the recalled
  // id, so twins that differ only in their export details stay distinct.
  const activePresetId = t.activeWorkspace?.id ?? null;
  const activeWorkspaceId = standalone && activePresetId !== null ? Number(activePresetId) : null;

  return (
    <SettingsPanel
      key={`${formEpoch}:${appliedEpoch}`}
      initial={{
        token: settings.token,
        selectedProjects: settings.selectedProjects,
        groupName: settings.groupName,
        shortFriday: settings.shortFriday,
        weeklyHours: settings.weeklyHours,
        maxBillableHours: settings.maxBillableHours,
        minWorkingDayHours: settings.minWorkingDayHours,
        billingTagPrefix: settings.billingTagPrefix,
        billByProject: settings.billByProject,
        stripCodeParens: settings.stripCodeParens,
        timeOffTag: settings.timeOffTag,
        roundingHours: settings.roundingHours,
        startWindowHours: settings.startWindowHours,
        maxDescriptionLength: settings.maxDescriptionLength,
        noOvertime: settings.noOvertime,
        codeMappings: settings.codeMappings,
        refreshSec: settings.refreshSec,
        timesheetMode: settings.timesheetMode,
        exportName: settings.exportName,
        // Edited in the export dialog, not in the panel — passed through so a
        // Save (or storing a new workspace) carries the active set along.
        exportFields: settings.exportFields,
      }}
      projects={projects}
      projectsLoaded={t.ready}
      serverManaged={!!t.serverManaged}
      mode={mode ?? 'toggl'}
      cacheInterval={t.cacheEnabled ? t.effectiveRefreshSec : null}
      authError={t.authError}
      connecting={t.connecting}
      presets={presets}
      onPresetsChange={(next) => {
        // Storing a workspace switches to it, and deleting the active one
        // leaves nothing active — keep the recalled-id pointer honest either
        // way, so export-detail writes land on the workspace on screen.
        const added = next.find((p) => !settings.presets.some((q) => q.id === p.id));
        const stillThere = next.some((p) => p.id === settings.activePresetId);
        persist({
          ...settings,
          presets: next,
          activePresetId: added?.id ?? (stillThere ? settings.activePresetId : null),
        });
      }}
      onApply={(p) => persist(applyPreset(settings, p, projects))}
      onConnect={(token) => t.connect(token, true)}
      onSave={(v) => {
        persist({ ...settings, ...v });
        t.setShowSettings(false);
      }}
      onClose={() => t.setShowSettings(false)}
      canClose={canClose}
      sync={t.sync}
      syncNotice={syncNotice}
      // Choosing "remote" applies the other device's document, which bumps
      // appliedEpoch — the effect above remounts the form and says so.
      onSyncResolve={(choice) => t.sync.resolveConflict(choice)}
      onSyncPassword={(pw) => t.submitPassword(pw)}
      syncPwBusy={t.pwBusy}
      syncPwError={t.pwError}
      onExportFile={t.sync.exportFile}
      onImportFile={async (file) => {
        const err = await t.sync.importFile(file);
        if (!err) {
          setSyncNotice('Settings file imported — everything below is now the imported setup.');
          setFormEpoch((n) => n + 1);
        }
        return err;
      }}
      activeWorkspaceId={activeWorkspaceId}
      activePresetId={activePresetId}
      openWorkspaces={openWorkspaces}
      onWorkspaceCreate={
        standalone
          ? async (name, snapshot) => {
              const ws = await t.createWorkspace(name, snapshot);
              if (!ws) return null;
              const preset: SettingsPreset = {
                id: String(ws.id),
                name: ws.name,
                color: ws.color,
                value: ws.settings,
              };
              // Creating a workspace switches to it — that's what makes the
              // first-run flow land somewhere usable.
              persist(applyPreset(t.settings, preset, projects));
              return preset;
            }
          : undefined
      }
      onWorkspaceRecapture={
        standalone
          ? (id, snapshot) => t.updateWorkspace(Number(id), { settings: snapshot })
          : undefined
      }
      onWorkspaceRename={
        standalone ? (id, name) => t.updateWorkspace(Number(id), { name }) : undefined
      }
      onWorkspaceColor={
        standalone ? (id, color) => t.updateWorkspace(Number(id), { color }) : undefined
      }
      onWorkspaceDelete={
        standalone
          ? async (id) => {
              const wsId = Number(id);
              const ws = t.workspaces.find((w) => w.id === wsId);
              // Cross-workspace integrity warning: other workspaces may still
              // point at this one (a linked billing code, or a tracked
              // selection). The server strips those references on delete —
              // but only after the user knowingly agrees to break the links.
              const referencing = t.workspaces.filter(
                (w) =>
                  w.id !== wsId &&
                  ((w.settings.codeMappings ?? []).some((m) => m.projectId === wsId) ||
                    w.settings.selectedProjects.some((p) => p.id === wsId))
              );
              if (referencing.length > 0) {
                const names = referencing.map((w) => `“${w.name}”`).join(', ');
                const sure = window.confirm(
                  `“${ws?.name ?? 'This workspace'}” is used by ${names} — as a linked ` +
                    'billing code or a tracked workspace. Deleting it removes those links ' +
                    'from their settings. Continue?'
                );
                if (!sure) return false;
              }
              const res = await t.deleteWorkspace(wsId, false);
              if (res === 'has-entries') {
                const sure = window.confirm(
                  `“${ws?.name ?? 'This workspace'}” still has tracked time entries. ` +
                    'Delete the workspace AND all its entries? This cannot be undone.'
                );
                if (!sure) return false;
                return (await t.deleteWorkspace(wsId, true)) === 'ok';
              }
              return res === 'ok';
            }
          : undefined
      }
    />
  );
}
