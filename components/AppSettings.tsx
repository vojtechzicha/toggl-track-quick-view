'use client';

// Wires SettingsPanel to the track source, shared by every page so the
// mapping can't drift.

import { useEffect, useState } from 'react';
import SettingsPanel from '@/components/SettingsPanel';
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
  const { settings, persist, projects } = t;

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

  // Resolved by id, so twins that differ only in export details stay distinct.
  const activePresetId = t.activeWorkspace?.id ?? null;

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
        balanceWeekdays: settings.balanceWeekdays,
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
      cacheInterval={t.cacheEnabled ? t.effectiveRefreshSec : null}
      authError={t.authError}
      connecting={t.connecting}
      presets={settings.presets}
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
      activePresetId={activePresetId}
      openWorkspaces={openWorkspaces}
    />
  );
}
