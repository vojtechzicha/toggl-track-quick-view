'use client';

// Wires SettingsPanel to the track source, shared by every page so the
// mapping can't drift. In standalone mode the "Workspaces" section manages
// server documents instead of localStorage presets, and stored workspaces
// double as the selectable "projects".

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
  // Opened from the topbar's "Manage workspaces…": scroll to that section.
  openWorkspaces?: boolean;
}) {
  const { settings, persist, projects, mode } = t;
  const standalone = mode === 'standalone';

  // The form snapshots `settings` on mount. If settings are replaced
  // underneath it, the next Save would overwrite them, so the panel remounts
  // (changed key) and a notice explains why the fields changed.
  //
  // Two triggers: a settings-file import (formEpoch) and a document adopted
  // from another device by a background pull or conflict resolution
  // (sync.appliedEpoch).
  const [formEpoch, setFormEpoch] = useState(0);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const appliedEpoch = t.sync.appliedEpoch;
  const [seenAppliedEpoch, setSeenAppliedEpoch] = useState(appliedEpoch);
  useEffect(() => {
    if (appliedEpoch === seenAppliedEpoch) return;
    setSeenAppliedEpoch(appliedEpoch);
    setSyncNotice('Settings updated from another device.');
  }, [appliedEpoch, seenAppliedEpoch]);

  // Standalone mode lists server workspaces in place of localStorage presets.
  const presets: SettingsPreset[] = standalone
    ? t.workspaces.map((w) => ({
        id: String(w.id),
        name: w.name,
        color: w.color,
        value: w.settings,
      }))
    : settings.presets;

  // The active workspace is excluded from the linked-codes picker: a workspace
  // can't be a linked code on its own timesheet. Resolved by id, so twins that
  // differ only in export details stay distinct.
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
        // Edited in the export dialog; passed through so Save keeps them.
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
        // Storing a workspace switches to it; deleting the active one clears
        // the pointer. Export-detail writes go to the workspace on screen.
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
      // "remote" bumps appliedEpoch, which remounts the form (see above).
      onSyncResolve={(choice) => t.sync.resolveConflict(choice)}
      onSyncPassword={(pw) => t.submitPassword(pw)}
      syncPwBusy={t.pwBusy}
      syncPwError={t.pwError}
      onExportFile={t.sync.exportFile}
      onImportFile={async (file) => {
        const err = await t.sync.importFile(file);
        if (!err) {
          setSyncNotice('Settings file imported.');
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
              // Switch to the new workspace so first run lands somewhere usable
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
              // Other workspaces may reference this one (linked billing code
              // or tracked selection). The server strips those references on
              // delete, so ask first.
              const referencing = t.workspaces.filter(
                (w) =>
                  w.id !== wsId &&
                  ((w.settings.codeMappings ?? []).some((m) => m.projectId === wsId) ||
                    w.settings.selectedProjects.some((p) => p.id === wsId))
              );
              if (referencing.length > 0) {
                const names = referencing.map((w) => `“${w.name}”`).join(', ');
                const sure = window.confirm(
                  `“${ws?.name ?? 'This workspace'}” is used by ${names} as a linked ` +
                    'billing code or tracked workspace. Deleting it removes those links. ' +
                    'Continue?'
                );
                if (!sure) return false;
              }
              const res = await t.deleteWorkspace(wsId, false);
              if (res === 'has-entries') {
                const sure = window.confirm(
                  `“${ws?.name ?? 'This workspace'}” still has tracked time entries. ` +
                    'Delete the workspace and all its entries? This cannot be undone.'
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
