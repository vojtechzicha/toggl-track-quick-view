'use client';

// The one place SettingsPanel is wired to the track source. All three pages
// (dashboard, timesheet, tracker) render the same settings surface; this
// wrapper owns the mapping so they can't drift — most importantly the
// standalone branch, where the panel's "Workspaces" section manages server
// documents (create/recapture/rename/recolor/delete) instead of the
// localStorage preset list, and stored workspaces double as the selectable
// "projects".

import SettingsPanel, { presetMatches, type SettingsPreset } from '@/components/SettingsPanel';
import { applyPreset, type UseTrackSource } from '@/lib/useTrackSource';

export default function AppSettings({
  t,
  canClose,
}: {
  t: UseTrackSource;
  canClose: boolean;
}) {
  const { settings, persist, projects, mode } = t;
  const standalone = mode === 'standalone';

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
  // its own timesheet as a linked code.
  const activeWorkspaceId = standalone
    ? t.workspaces.find((w) => presetMatches(w.settings, settings))?.id ?? null
    : null;

  return (
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
        noOvertime: settings.noOvertime,
        codeMappings: settings.codeMappings,
        refreshSec: settings.refreshSec,
        timesheetMode: settings.timesheetMode,
        exportName: settings.exportName,
      }}
      projects={projects}
      serverManaged={!!t.serverManaged}
      mode={mode ?? 'toggl'}
      cacheInterval={t.cacheEnabled ? t.effectiveRefreshSec : null}
      authError={t.authError}
      connecting={t.connecting}
      presets={presets}
      onPresetsChange={(next) => persist({ ...settings, presets: next })}
      onApply={(p) => persist(applyPreset(settings, p, projects))}
      onConnect={(token) => t.connect(token, true)}
      onSave={(v) => {
        persist({ ...settings, ...v });
        t.setShowSettings(false);
      }}
      onClose={() => t.setShowSettings(false)}
      canClose={canClose}
      activeWorkspaceId={activeWorkspaceId}
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
