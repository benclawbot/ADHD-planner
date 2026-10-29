import {
  createDemoState,
  acceptCaptureProposal,
  createCaptureProposal,
  isReferenceCaptureText,
  loadState,
  makeId,
  removeTask,
  reminderAt,
  reorderCaptureTask,
  parseBackup,
  saveState,
  todayKey,
} from './model.js';
import { createSyncClient, preservePreLinkPlan } from './sync-client.js';
import { LocalVoiceCapture, appendTranscript, voiceErrorMessage } from './voice-capture.js';
import { buildDayPlan, buildWeekPlan, validatePlanningTask } from './planning.js';
import {
  createWeeklyRecurrence,
  getWeeklyWindowForInstant,
  getCalendarDateForInstant,
  listWeeklyOccurrences,
  recordWeeklyCompletion,
  validateWeeklyRecurrence,
} from './recurrence.js';
import {
  addProposedSubtask,
  cancelSubtaskProposal,
  commitSubtaskProposal,
  createSubtaskProposal,
  editProposedSubtask,
  editSubtask,
  getSubtasks,
  removeProposedSubtask,
  removeSubtask,
  reorderProposedSubtask,
  reorderSubtask,
  undoProposedSubtaskRemoval,
  undoRemoveSubtask,
} from './subtasks.js';

const frame = document.querySelector('#screen');
const storage = window.localStorage;
const sharedCapabilityKey = 'tempo-shared-capability-v1';
function captureSharedCapability() {
  let target = window;
  try { if (window.top && window.top.location.origin === window.location.origin) target = window.top; } catch { /* Keep the current PWA URL. */ }
  const hash = target.location.hash;
  const token = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('tempo');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return;
  try { storage.setItem(sharedCapabilityKey, token); } catch { return; }
  target.history.replaceState(target.history.state, '', `${target.location.pathname}${target.location.search}`);
}
captureSharedCapability();
let state = loadState(storage);
const HYPERFOCUS_CHECKIN_INTERVAL_MS = 60 * 60_000;
const PERSISTENT_REMINDER_INTERVAL_MS = 10 * 60_000;
const demoSeedTasks = new Map(createDemoState().tasks.map((task) => [task.id, task]));
const accountRecoveryKey = 'tempo-account-local-recovery-v1';
let sharedPlanRecoveryError = null;
let sharedPlanBootstrapPending = false;
let sharedPlanRecoveryReady = true;
try {
  const sharedCapability = storage.getItem(sharedCapabilityKey);
  const syncRecord = JSON.parse(storage.getItem('tempo-sync-client-v1') ?? 'null');
  const knownUserId = syncRecord?.siteUserId ?? syncRecord?.session?.user?.id ?? null;
  sharedPlanBootstrapPending = Boolean(sharedCapability && (!knownUserId || syncRecord?.hydrated !== true));
} catch {
  sharedPlanBootstrapPending = Boolean(storage.getItem(sharedCapabilityKey));
}
let applyingCloudState = false;
let screenName = 'today';
let liveWeekStartDate = null;
let liveWeekShowWeekend = false;
let tickHandle = null;
let reminderHandle = null;
let persistentReminderHandle = null;
let persistentReminderQuietUntil = 0;
let transitionHandle = null;
let toastTimer = null;
let syncQueueWarningShown = false;
let reminderNotified = new Set();
let transitionNotified = new Set();
let focusRunStartedAt = null;
let focusRunTaskId = null;
const voiceCapture = new LocalVoiceCapture();
let voiceBusy = false;

const syncClient = createSyncClient({
  storage,
  siteAuth: true,
  onStatus: (status) => {
    renderSyncStatus(frame.contentDocument, status);
  },
  onIdentityChange: ({ previousUserId }) => {
    if (previousUserId && !state.demoData) archivePreviousLocalPlan();
  },
  onRemoteState: (remoteState, meta) => {
    if (sharedPlanBootstrapPending) {
      try {
        if (!archiveLocalPlanBeforeSharedSync(syncClient.getPendingOperations())) return false;
      } catch {
        sharedPlanRecoveryError = 'local_recovery_unavailable';
        return false;
      }
    }
    const applied = applyRemoteState(remoteState, meta);
    if (applied) {
      sharedPlanBootstrapPending = false;
      sharedPlanRecoveryError = null;
    }
    return applied;
  },
  onConflict: (conflict) => renderSyncConflict(frame.contentDocument, conflict),
});

if (sharedPlanBootstrapPending) {
  try {
    sharedPlanRecoveryReady = syncClient.prepareSharedPlanBootstrap(archiveLocalPlanBeforeSharedSync);
    if (!sharedPlanRecoveryReady) sharedPlanRecoveryError = 'local_recovery_unavailable';
  } catch {
    sharedPlanRecoveryReady = false;
    sharedPlanRecoveryError = 'local_recovery_unavailable';
  }
}

function archiveLocalPlanBeforeSharedSync(queuedOperations = []) {
  return preservePreLinkPlan(storage, accountRecoveryKey, state, queuedOperations);
}

function syncableState(localState) {
  const tasks = (localState.tasks ?? []).filter((task) => {
    const seed = demoSeedTasks.get(task.id);
    return !seed || JSON.stringify(task) !== JSON.stringify(seed);
  });
  const result = { ...localState, tasks };
  if (result.currentTaskId && demoSeedTasks.has(result.currentTaskId) && !tasks.some((task) => task.id === result.currentTaskId)) {
    delete result.currentTaskId;
  }
  if (result.focus?.taskId && demoSeedTasks.has(result.focus.taskId) && !tasks.some((task) => task.id === result.focus.taskId)) {
    result.focus = null;
  }
  return result;
}

function saveLocalState(nextState) {
  state = saveState(storage, nextState);
  schedulePersistentTaskReminders(frame.contentDocument);
  if (!applyingCloudState) {
    try {
      syncClient.setLocalState(syncableState(state));
      syncQueueWarningShown = false;
    } catch (error) {
      if (error?.code === 'account_hydrating') {
        return state;
      }
      const doc = frame.contentDocument;
      if (!syncQueueWarningShown && doc?.body) {
        syncQueueWarningShown = true;
        showToast(doc, 'Saved on this device, but the sync queue could not be saved. Export a backup before closing.');
      }
    }
  }
  return state;
}

function persist() {
  saveLocalState(state);
  syncScreen();
}

function activeTasks() {
  return state.tasks.filter((task) => task.status !== 'removed');
}

function visibleTodayTasks() {
  return activeTasks().filter((task) => task.scheduledDate === todayKey() && task.status !== 'done');
}

function routeTo(route, push = true) {
  const normalized = route === 'week' ? 'week' : route;
  if (push && window.location.hash !== `#${normalized}`) window.location.hash = normalized;
  else {
    screenName = normalized;
    renderScreen();
  }
}

function routeFromLocation() {
  screenName = (window.location.hash.slice(1) || 'today').split('/')[0];
  if (!['today', 'week', 'plan', 'focus', 'brain-dump', 'settings', 'sync'].includes(screenName)) screenName = 'today';
  renderScreen();
}

function templateFor(route, wide) {
  if (wide && route === 'today') return 'desktop-today.html';
  if (wide && route === 'week') return 'desktop-week.html';
  if (route === 'today') return 'today.html';
  if (route === 'focus') return 'focus.html';
  if (route === 'brain-dump') return 'brain-dump.html';
  if (route === 'settings') return 'settings.html';
  if (route === 'sync') return 'sync-settings.html';
  return 'mobile-plan.html';
}

function renderScreen() {
  window.clearInterval(tickHandle);
  tickHandle = null;
  const wide = window.matchMedia('(min-width: 768px)').matches;
  const phoneView = !wide || !['today', 'week'].includes(screenName);
  frame.className = phoneView ? (wide ? 'centered' : 'phone') : '';
  frame.title = `Tempo ${screenName.replace('-', ' ')}`;
  frame.src = `/src/templates/${templateFor(screenName, wide).replace(/\.html$/, '')}`;
  frame.onload = () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    installDialogStyles(doc);
    installToast(doc);
    bindNavigation(doc);
    applyResponsive(doc, phoneView, wide);
    applyLowStimulation(doc);
    if (screenName === 'settings' || screenName === 'sync') configureSettings(doc);
    if (screenName === 'settings') configureReferenceSync(doc);
    if (screenName === 'today' || screenName === 'week') configurePlanScreen(doc, wide);
    if (screenName === 'plan') configureMobilePlan(doc);
    if (screenName === 'brain-dump') configureCapture(doc);
    if (screenName === 'focus') configureFocus(doc);
    scheduleDepartureReminder(doc);
    schedulePersistentTaskReminders(doc);
  };
}

function applyResponsive(doc, phoneView, wide) {
  const style = doc.createElement('style');
  style.textContent = `
    html,body{min-height:100%;margin:0}
    @media(max-width:389px){body>div[style*="width: 390px"]{width:100vw!important;height:auto!important;min-height:100dvh!important;overflow:visible!important;padding-left:16px!important;padding-right:16px!important}#plan{width:100vw!important}}
    @media(max-height:843px){body>div[style*="height: 844px"]{height:auto!important;min-height:100dvh!important;overflow:visible!important}body>div[style*="height: 844px"]>div[style*="bottom: 0"]{position:sticky!important;margin-top:auto}}
    .tempo-accessible-action{cursor:pointer}
    .tempo-more-action{cursor:pointer}
    .tempo-more-action:hover{background:#E9EEF6!important;border-color:#2B5FC4!important;color:#1B4FA8!important}
    .tempo-toast{position:fixed;z-index:2147483000;left:12px;right:12px;bottom:94px;padding:12px 14px;background:#1B2430;color:#fff;border-radius:10px;font:16px/1.4 'Atkinson Hyperlegible',system-ui,sans-serif;box-shadow:0 3px 12px rgba(18,30,50,.25)}
    dialog.tempo-dialog{width:min(360px,calc(100vw - 28px));max-height:calc(100dvh - 28px);overflow:auto;border:1px solid #D5DCE6;border-radius:14px;padding:18px;background:#F5F7F9;color:#1B2430;font:16px/1.4 'Atkinson Hyperlegible',system-ui,sans-serif}
    dialog.tempo-dialog::backdrop{background:rgba(18,30,50,.48)}
    .tempo-dialog [hidden]{display:none!important}
    .tempo-dialog h2{margin:0 0 14px;font-size:22px}.tempo-dialog form{display:grid;gap:12px}.tempo-dialog label{display:grid;gap:5px;font-weight:700}.tempo-dialog input,.tempo-dialog select,.tempo-dialog textarea{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #AAB5C4;border-radius:8px;padding:8px 10px;background:white;color:#1B2430;font:inherit}.tempo-dialog input[type=checkbox]{width:22px;min-height:22px;accent-color:#2B5FC4}.tempo-dialog .inline{display:flex;align-items:center;gap:10px}.tempo-dialog .actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}.tempo-dialog button{min-height:44px;border:1px solid #1B2430;border-radius:9px;padding:6px 12px;background:white;color:#1B2430;font:inherit;font-weight:700}.tempo-dialog button.primary{background:#2B5FC4;border-color:#2B5FC4;color:white}.tempo-dialog button.danger{color:#832E2E;border-color:#832E2E}.tempo-dialog button:focus-visible,.tempo-dialog input:focus-visible,.tempo-dialog select:focus-visible,.tempo-dialog textarea:focus-visible{outline:3px solid #C17A3A;outline-offset:2px}
    .tempo-task-swipe{position:relative;min-width:0;overflow:hidden;border-radius:10px;touch-action:pan-y}
    .tempo-task-row{position:relative;z-index:1;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:6px 12px;background:white;border-radius:10px;color:#1B2430;font:16px/1.25 'Atkinson Hyperlegible',system-ui,sans-serif;text-align:left;transition:transform 160ms ease-out}
    .tempo-task-swipe.is-revealed .tempo-task-row{transform:translateX(-84px)}
    .tempo-task-remove{position:absolute;inset:0 0 0 auto;width:84px;border:0;background:#A93636;color:white;font:700 15px/1 'Atkinson Hyperlegible',system-ui,sans-serif;cursor:pointer}
    .tempo-task-remove:focus-visible{outline:3px solid #C17A3A;outline-offset:-4px}
    .tempo-task-row button{border:0;background:transparent;color:inherit;font:inherit;text-align:left;flex:1;min-height:40px;cursor:pointer}
    .tempo-task-row small{display:block;color:#4A5565;font-size:13px;margin-top:3px}
    .tempo-task-row .edit-label{white-space:nowrap;color:#1B4FA8;font-size:14px}
    .tempo-list{display:grid;gap:7px}
    .tempo-week-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
    .tempo-week-toolbar button,.tempo-week-toolbar input{box-sizing:border-box;min-height:44px;border:1px solid #1B2430;border-radius:9px;padding:6px 12px;background:#FFFFFF;color:#1B2430;font:inherit;font-weight:700}
    .tempo-week-toolbar button{cursor:pointer}
    .tempo-week-toolbar button.primary{background:#2B5FC4;border-color:#2B5FC4;color:#FFFFFF}
    .tempo-week-toolbar input{font-weight:400}
    .tempo-week-toolbar button:focus-visible,.tempo-week-toolbar input:focus-visible,.tempo-week-task-link:focus-visible,.tempo-week-event:focus-visible{outline:3px solid #C17A3A;outline-offset:2px}
    .tempo-week-grid{display:grid;grid-template-columns:repeat(5,minmax(170px,1fr));gap:12px;overflow-x:auto;align-items:start}
    .tempo-week-grid.weekend{grid-template-columns:repeat(2,minmax(170px,1fr))}
    .tempo-week-day{box-sizing:border-box;min-width:0;background:#FFFFFF;border:1px solid #D5DCE6;border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px}
    .tempo-week-day.is-today{border:2px solid #2B5FC4;padding:13px}
    .tempo-week-day h2{margin:0;font-size:16px;line-height:1.25}
    .tempo-week-day-head{display:flex;flex-direction:column;gap:2px}
    .tempo-week-day-summary{font-size:13px;color:#4A5565}
    .tempo-week-capacity{height:10px;border-radius:5px;background:#DDE3EC;overflow:hidden}
    .tempo-week-capacity>span{display:block;height:100%;background:#7FA3DB}
    .tempo-week-day.is-today .tempo-week-capacity>span{background:#2B5FC4}
    .tempo-week-capacity-note{font-size:13px;color:#4A5565}
    .tempo-week-track{position:relative;height:400px;min-width:0;overflow:hidden;background:repeating-linear-gradient(to bottom,#E1E6EE 0,#E1E6EE 1px,transparent 1px,transparent 40px)}
    .tempo-week-event{position:absolute;box-sizing:border-box;z-index:2;min-width:0;min-height:0;margin:0;border:0;border-radius:7px;padding:1px 4px;overflow:hidden;background:#E4ECF8;color:#1B2430;font:700 12px/1.05 'Atkinson Hyperlegible',system-ui,sans-serif;text-align:left;overflow-wrap:anywhere;cursor:pointer}
    .tempo-week-event.status-done{background:#EDEFF3;color:#4A5565;text-decoration:line-through}
    .tempo-week-event.is-today{background:#2B5FC4;color:#FFFFFF}
    .tempo-week-event.status-done.is-today{background:#D6DEEA;color:#1B2430}
    .tempo-week-open-gap{position:absolute;z-index:1;left:0;right:0;display:flex;align-items:center;justify-content:center;border-top:1px dashed #8A96A8;border-bottom:1px dashed #8A96A8;color:#4A5565;font-size:11px;pointer-events:none}
    .tempo-week-open-gap span{padding:1px 4px;background:#FFFFFF}
    .tempo-week-clock-range{font-size:12px;color:#4A5565;font-variant-numeric:tabular-nums}
    .tempo-week-extra{display:grid;gap:6px;padding-top:6px;border-top:1px solid #D5DCE6}
    .tempo-week-extra h3{margin:0;font-size:14px}
    .tempo-week-task-link{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;border:0;border-radius:8px;padding:6px 8px;background:#F5F7F9;color:#1B2430;font:inherit;font-size:14px;text-align:left;cursor:pointer}
    .tempo-week-footer{display:grid;gap:8px;background:#E9EEF6;border-radius:12px;padding:12px 14px;font-size:14px;line-height:1.45}
    .tempo-week-footer p{margin:0}
    .tempo-week-footer button{border:0;padding:0;background:transparent;color:#1B4FA8;font:inherit;text-decoration:underline;text-underline-offset:3px;cursor:pointer}
    .tempo-week-footer button:focus-visible{outline:3px solid #C17A3A;outline-offset:2px;border-radius:3px}
    @media(max-width:767px){.tempo-week-grid,.tempo-week-grid.weekend{grid-template-columns:minmax(0,1fr);overflow:visible}.tempo-week-track{height:400px}}
    .tempo-weekly-fields{padding:10px 12px;border-radius:10px;background:#E9EEF6;color:#1B2430;font-size:14px;line-height:1.4}.tempo-weekly-fields p{margin:0 0 8px}.tempo-weekly-history{flex-basis:100%;margin:0 4px 8px;color:#4A5565;font-size:14px;line-height:1.4}.tempo-weekly-history summary{min-height:44px;display:flex;align-items:center;cursor:pointer}.tempo-weekly-history ul{margin:4px 0 8px;padding-left:22px}.tempo-weekly-history li{margin:4px 0;font-variant-numeric:tabular-nums}
    .tempo-subtask-summary{padding-top:10px;border-top:1px solid #D5DCE6}.tempo-subtask-summary h3,.tempo-subtask-manager h3{margin:0 0 6px;font-size:18px}.tempo-subtask-summary p,.tempo-subtask-manager p{margin:0 0 10px;color:#4A5565;font-size:14px;line-height:1.4}.tempo-subtask-summary ol{margin:0 0 10px;padding-left:22px}.tempo-subtask-summary li{margin:4px 0;overflow-wrap:anywhere}.tempo-subtask-summary button,.tempo-subtask-manager button{min-height:44px;border:1px solid #1B2430;border-radius:9px;padding:6px 12px;background:white;color:#1B2430;font:inherit;font-weight:700;cursor:pointer}.tempo-subtask-summary button.primary,.tempo-subtask-manager button.primary{background:#2B5FC4;border-color:#2B5FC4;color:white}.tempo-subtask-manager{display:grid;gap:14px}.tempo-subtask-manager section{display:grid;gap:8px}.tempo-subtask-manager ol{display:grid;gap:8px;margin:0;padding:0;list-style:none}.tempo-subtask-item{display:grid;gap:8px;padding:10px;border:1px solid #D5DCE6;border-radius:10px;background:white}.tempo-subtask-item label{display:grid;gap:5px;font-size:14px;font-weight:700}.tempo-subtask-item input,.tempo-subtask-manager textarea{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #AAB5C4;border-radius:8px;padding:8px 10px;background:white;color:#1B2430;font:inherit}.tempo-subtask-manager textarea{min-height:96px;resize:vertical}.tempo-subtask-item .actions,.tempo-subtask-manager .actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:0}.tempo-subtask-item button,.tempo-subtask-manager button{min-height:40px;font-size:14px}.tempo-subtask-item button.danger,.tempo-subtask-manager button.danger{color:#832E2E;border-color:#832E2E}.tempo-subtask-item button:disabled,.tempo-subtask-manager button:disabled{opacity:.52;cursor:not-allowed}.tempo-subtask-item button:focus-visible,.tempo-subtask-manager button:focus-visible,.tempo-subtask-manager input:focus-visible,.tempo-subtask-manager textarea:focus-visible{outline:3px solid #C17A3A;outline-offset:2px}.tempo-subtask-empty{padding:10px 12px;border-radius:10px;background:#E9EEF6;color:#1B2430;font-size:14px;line-height:1.4}.tempo-toast .tempo-toast-undo{min-height:40px;margin-left:12px;border:1px solid rgba(255,255,255,.75);border-radius:7px;padding:5px 10px;background:transparent;color:white;font:inherit;font-weight:700;cursor:pointer}
    .tempo-capture-list,.tempo-capture-group{display:grid;gap:8px}
    .tempo-capture-group{padding:4px 0}
    .tempo-capture-group details{font-size:14px;color:#4A5565;padding:2px 4px}
    .tempo-capture-group p{margin:6px 0 0;color:#1B2430;overflow-wrap:anywhere}
    .tempo-capture-review{display:grid;gap:12px}
    .tempo-capture-review .source{margin:0;padding:10px 12px;border-radius:10px;background:#E9EEF6;overflow-wrap:anywhere;font-size:14px}
    .tempo-capture-review ol{display:grid;gap:8px;margin:0;padding:0;list-style:none}
    .tempo-capture-item{display:grid;gap:8px;padding:10px;border:1px solid #D5DCE6;border-radius:10px;background:#FFFFFF}
    .tempo-capture-item label{display:grid;gap:5px;font-size:14px;font-weight:700}
    .tempo-capture-item label.include{display:flex;align-items:center;gap:8px;font-weight:400}
    .tempo-capture-item input[type=text]{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #AAB5C4;border-radius:8px;padding:8px 10px;background:#FFFFFF;color:#1B2430;font:inherit}
    .tempo-capture-review .actions{display:flex;flex-wrap:wrap;gap:8px}
    .tempo-capture-review button{min-height:44px;border:1px solid #1B2430;border-radius:9px;padding:6px 12px;background:#FFFFFF;color:#1B2430;font:inherit;font-weight:700;cursor:pointer}
    .tempo-capture-review button.primary{background:#2B5FC4;border-color:#2B5FC4;color:#FFFFFF}
    .tempo-capture-review button:focus-visible,.tempo-capture-item input:focus-visible{outline:3px solid #C17A3A;outline-offset:2px}
    .tempo-switch:focus-within{outline:3px solid #C17A3A;outline-offset:2px;border-radius:15px}
    .tempo-route-button{border:0;background:transparent;font:inherit;color:inherit;cursor:pointer;padding:0}
    html.tempo-low-stimulation{filter:saturate(.5)}
    html.tempo-low-stimulation [data-tempo-badge],html.tempo-low-stimulation .tempo-badge,html.tempo-low-stimulation [data-badge]{display:none!important}
    .tempo-persistent-reminder{display:grid;gap:8px}.tempo-persistent-reminder p{margin:0}.tempo-persistent-reminder .actions{display:flex;flex-wrap:wrap;gap:8px}.tempo-persistent-reminder button{min-height:40px;padding:4px 10px;border:1px solid rgba(255,255,255,.78);border-radius:8px;background:transparent;color:inherit;font:inherit;font-weight:700;cursor:pointer}.tempo-persistent-reminder button:focus-visible{outline:3px solid #C17A3A;outline-offset:2px}.tempo-reminder-note{margin:-6px 0 0;color:#4A5565;font-size:14px;line-height:1.35}
    @media(max-height:700px){dialog.tempo-dialog{padding:14px}.tempo-dialog form{gap:8px}}
  `;
  doc.head.append(style);
}

function applyLowStimulation(doc) {
  if (!doc?.documentElement) return;
  doc.documentElement.classList.toggle('tempo-low-stimulation', Boolean(state.settings?.lowStimulation));
  for (const span of doc.querySelectorAll('span')) {
    const text = span.textContent.trim();
    if (text === 'NOW' || /^Session \d+ of \d+$/.test(text)) span.dataset.tempoBadge = 'true';
  }
}

function installDialogStyles(doc) {
  if (doc.querySelector('#tempo-dialog-style')) return;
}

function installToast(doc) {
  if (!doc.body) return;
  doc.addEventListener('click', (event) => {
    const target = event.target.closest('[data-toast]');
    if (target) showToast(doc, target.dataset.toast);
  });
}

function showToast(doc, message) {
  if (!doc?.body) return;
  let toast = doc.querySelector('.tempo-toast');
  if (!toast) {
    toast = doc.createElement('div');
    toast.className = 'tempo-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    doc.body.append(toast);
  }
  toast.textContent = message;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.remove(), 3800);
}

function bindNavigation(doc) {
  const labels = new Map([
    ['Today', 'today'], ['Week', 'week'], ['Plan', 'plan'], ['Focus', 'focus'], ['Brain dump', 'brain-dump'],
  ]);
  for (const element of doc.querySelectorAll('span,button,a')) {
    const label = element.textContent.trim();
    if (!labels.has(label)) continue;
    if (element.closest('#plan')) continue;
    if (element.parentElement?.closest('[style*="bottom: 0"]') || element.closest('[style*="flex-direction: column; gap: 14px"]') || element.closest('nav')) {
      element.classList.add('tempo-route-button');
      element.setAttribute('aria-label', `Open ${label}`);
      element.addEventListener('click', () => routeTo(labels.get(label)));
      if (element.tagName !== 'BUTTON' && element.tagName !== 'A') {
        element.setAttribute('role', 'link');
        element.tabIndex = 0;
        element.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); routeTo(labels.get(label)); }
        });
      }
    }
  }
  doc.querySelectorAll('[data-route]').forEach((button) => button.addEventListener('click', () => routeTo(button.dataset.route)));
}

function ensureDialog(doc) {
  let dialog = doc.querySelector('#tempo-task-dialog');
  if (dialog) return dialog;
  dialog = doc.createElement('dialog');
  dialog.id = 'tempo-task-dialog';
  dialog.className = 'tempo-dialog';
  dialog.setAttribute('aria-labelledby', 'tempo-task-title');
  doc.body.append(dialog);
  return dialog;
}

function formValue(form, name) {
  return form.elements.namedItem(name)?.value ?? '';
}

function currentWeeklyTaskState(task, instant = new Date()) {
  const errors = validateWeeklyRecurrence(task?.recurrence);
  if (errors.length) return { valid: false, error: errors[0] };
  try {
    const completions = weeklyCompletionList(task);
    const window = getWeeklyWindowForInstant(task.recurrence, instant);
    const beforeStart = window.startDate < task.recurrence.startsOn;
    const completion = completions.find((item) => item.windowStart === window.startDate) ?? null;
    return { valid: true, window, beforeStart, completed: completion !== null, completion };
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

function weeklyCompletionList(task) {
  const stored = task?.recurrenceCompletions ?? {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new TypeError('Weekly completion history must be keyed by window start date.');
  }
  return Object.entries(stored).map(([windowStart, completedAt]) => ({ windowStart, completedAt }));
}

function weeklyCompletionMap(completions) {
  return Object.fromEntries(completions.map(({ windowStart, completedAt }) => [windowStart, completedAt]));
}

function recurringHistoryDisclosure(doc, task) {
  if (!task.recurrence) return null;
  const disclosure = doc.createElement('details');
  disclosure.className = 'tempo-weekly-history';
  const summary = doc.createElement('summary');
  disclosure.append(summary);
  try {
    const throughDate = getCalendarDateForInstant(new Date(), task.recurrence.timeZone);
    const occurrences = listWeeklyOccurrences(task.recurrence, throughDate, weeklyCompletionList(task));
    const past = occurrences.filter((occurrence) => occurrence.isPast);
    if (!past.length) return null;
    summary.textContent = `Past windows not completed (${past.length})`;
    const list = doc.createElement('ul');
    for (const occurrence of past) {
      const item = doc.createElement('li');
      item.textContent = `${occurrence.startDate} to ${occurrence.endDate}`;
      list.append(item);
    }
    disclosure.append(list);
  } catch {
    summary.textContent = 'Weekly history needs review';
    disclosure.setAttribute('aria-label', 'Weekly history could not be shown');
  }
  return disclosure;
}

function openTaskDialog(doc, task = null) {
  const dialog = ensureDialog(doc);
  const editing = task !== null;
  const today = todayKey();
  const weeklyRecurrence = Boolean(task?.recurrence);
  const scheduleValue = weeklyRecurrence ? 'week' : task?.scheduledDate === today ? 'today' : task?.scheduledDate ? 'date' : task?.scheduleWindow === 'this-week' ? 'week' : 'later';
  const recurringStatus = weeklyRecurrence ? currentWeeklyTaskState(task) : null;
  const completeButtonLabel = weeklyRecurrence
    ? recurringStatus?.completed ? 'Completed this week' : recurringStatus?.beforeStart ? `Starts week of ${task.recurrence.startsOn}` : recurringStatus?.valid ? 'Mark complete this week' : 'Weekly settings need review'
    : task?.status === 'done' ? 'Undo completion' : 'Mark complete';
  const completeButtonDisabled = weeklyRecurrence && (!recurringStatus?.valid || recurringStatus.beforeStart || recurringStatus.completed);
  const capture = task?.parentCaptureId ? state.captures.find((entry) => entry.id === task.parentCaptureId) : null;
  const parentTask = task?.parentTaskId ? state.tasks.find((entry) => entry.id === task.parentTaskId) : null;
  const childList = task?.parentTaskId
    ? getSubtasks(state, task.parentTaskId)
    : task?.parentCaptureId
      ? activeTasks().filter((child) => child.parentCaptureId === task.parentCaptureId).sort((a,b) => a.order-b.order)
      : [];
  const index = childList.findIndex((child) => child.id === task?.id);
  const removable = Boolean(task?.parentCaptureId || task?.parentTaskId);
  const canManageSubtasks = Boolean(editing && !task.parentCaptureId && !task.parentTaskId);
  dialog.innerHTML = `
    <h2 id="tempo-task-title">${editing ? 'Edit task' : 'Add a task'}</h2>
    ${capture ? `<p>Linked to your original capture: <q>${escapeHtml(capture.text)}</q></p>` : ''}
    ${parentTask ? `<p>Subtask linked to: <q>${escapeHtml(parentTask.title)}</q></p>` : ''}
    <form method="dialog">
      <label>Task<input name="title" required maxlength="160" autocomplete="off"></label>
      <label>Estimated minutes<input name="duration" type="number" min="0" max="1440" step="5"></label>
      <label>Context<input name="category" maxlength="80"></label>
      <label>Schedule<select name="schedule"><option value="later">Later · not scheduled</option><option value="week">This week · flexible</option><option value="today">Today</option><option value="date">Choose a date</option></select></label>
      <label data-schedule-date-field hidden>Scheduled date<input name="scheduledDate" type="date"></label>
      <label class="inline"><input name="repeatWeekly" type="checkbox"> Repeat in a weekly window</label>
      <section class="tempo-weekly-fields" data-weekly-fields hidden>
        <p>Each window is seven calendar days in this time zone. One completion covers a window; past windows stay visible.</p>
        <label>Time zone (IANA)<input name="recurrenceTimeZone" type="text" placeholder="Europe/Paris" autocomplete="off" required></label>
        <label>First window starts on<input name="recurrenceStartsOn" type="date" required></label>
        <label>Week starts on<select name="recurrenceWeekStartsOn" required><option value="">Choose a weekday</option><option value="0">Sunday</option><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option></select></label>
      </section>
      <label>Start time (optional)<input name="startTime" type="time"></label>
      <label>Due date and time (optional)<input name="deadline" type="datetime-local"></label>
      <label class="inline"><input name="persistentReminder" type="checkbox"> Repeat every 10 min after this task is due</label>
      <p class="tempo-reminder-note">At most one repeat every 10 min until done or turned off. Tempo must stay open; system delivery needs browser permission.</p>
      <label>Smallest next step<textarea name="nextStep" rows="2" maxlength="240"></textarea></label>
      <label>Leave time (optional)<input name="departureTime" type="datetime-local"></label>
      <label class="inline"><input name="leaveReminder" type="checkbox"> Gentle reminder before leaving</label>
      <label>Reminder lead time in minutes<input name="leadMinutes" type="number" min="1" max="180" value="2"></label>
      <label>Delivery<select name="delivery"><option value="quiet">Quiet notification</option><option value="system">System notification</option></select></label>
      ${canManageSubtasks ? `<section class="tempo-subtask-summary" aria-labelledby="tempo-subtask-summary-title"><h3 id="tempo-subtask-summary-title">Subtasks</h3><p>Steps stay linked to this task. Its completion status stays as you set it.</p><div data-task-subtask-summary></div><button type="button" data-manage-subtasks>Review linked steps</button></section>` : ''}
      <div class="actions">
        <button class="primary" type="submit" value="save">Save task</button>
        ${editing ? `<button type="button" data-make-now>Make Now</button>` : ''}
        ${editing ? `<button type="button" data-toggle-complete ${completeButtonDisabled ? 'disabled' : ''}>${escapeHtml(completeButtonLabel)}</button>` : ''}
        ${removable ? `<button type="button" data-move="-1" ${index<=0?'disabled':''}>Move up</button><button type="button" data-move="1" ${index>=childList.length-1?'disabled':''}>Move down</button><button type="button" class="danger" data-remove>Remove</button>` : ''}
        <button type="button" data-cancel>Cancel</button>
      </div>
      ${editing ? '<p class="task-save-note" role="status"></p>' : ''}
    </form>`;
  const form = dialog.querySelector('form');
  form.elements.namedItem('title').value = task?.title ?? '';
  form.elements.namedItem('duration').value = String(task?.durationMinutes ?? 15);
  form.elements.namedItem('category').value = task?.category ?? '';
  form.elements.namedItem('schedule').value = scheduleValue;
  const repeatWeeklyField = form.elements.namedItem('repeatWeekly');
  const weeklyFields = form.querySelector('[data-weekly-fields]');
  const scheduleField = form.elements.namedItem('schedule');
  const scheduledDateField = form.elements.namedItem('scheduledDate');
  const scheduledDateLabel = form.querySelector('[data-schedule-date-field]');
  const recurrenceTimeZoneField = form.elements.namedItem('recurrenceTimeZone');
  const recurrenceStartsOnField = form.elements.namedItem('recurrenceStartsOn');
  const recurrenceWeekStartsOnField = form.elements.namedItem('recurrenceWeekStartsOn');
  repeatWeeklyField.checked = weeklyRecurrence;
  recurrenceTimeZoneField.value = task?.recurrence?.timeZone ?? '';
  recurrenceStartsOnField.value = task?.recurrence?.startsOn ?? '';
  recurrenceWeekStartsOnField.value = task?.recurrence ? String(task.recurrence.weekStartsOn) : '';
  scheduledDateField.value = task?.scheduledDate || today;
  const syncScheduleDateControl = () => {
    const enabled = !repeatWeeklyField.checked && scheduleField.value === 'date';
    scheduledDateLabel.hidden = !enabled;
    scheduledDateField.disabled = !enabled;
    scheduledDateField.required = enabled;
  };
  scheduleField.addEventListener('change', syncScheduleDateControl);
  const syncWeeklyControls = () => {
    const enabled = repeatWeeklyField.checked;
    weeklyFields.hidden = !enabled;
    for (const field of [recurrenceTimeZoneField, recurrenceStartsOnField, recurrenceWeekStartsOnField]) field.disabled = !enabled;
    scheduleField.disabled = enabled;
    if (enabled) scheduleField.value = 'week';
    syncScheduleDateControl();
  };
  repeatWeeklyField.addEventListener('change', syncWeeklyControls);
  syncWeeklyControls();
  form.elements.namedItem('startTime').value = task?.startTime ?? '';
  form.elements.namedItem('deadline').value = toLocalInput(task?.deadline ?? '');
  form.elements.namedItem('persistentReminder').checked = Boolean(task?.persistentReminderEnabled);
  form.elements.namedItem('nextStep').value = task?.nextStep ?? '';
  form.elements.namedItem('departureTime').value = toLocalInput(task?.departureTime ?? '');
  form.elements.namedItem('leaveReminder').checked = Boolean(task?.leaveReminderEnabled);
  form.elements.namedItem('leadMinutes').value = String(task?.leaveLeadMinutes ?? 2);
  form.elements.namedItem('delivery').value = task?.leaveDelivery ?? 'quiet';
  if (canManageSubtasks) refreshTaskSubtaskSummary(doc, task);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const schedule = formValue(form, 'schedule');
    const departureInput = form.elements.namedItem('departureTime');
    const reminderEnabled = form.elements.namedItem('leaveReminder').checked;
    const deadlineInput = form.elements.namedItem('deadline');
    const persistentReminderEnabled = form.elements.namedItem('persistentReminder').checked;
    departureInput.setCustomValidity(reminderEnabled && !departureInput.value ? 'Add a leave time or turn off this reminder.' : '');
    deadlineInput.setCustomValidity(persistentReminderEnabled && !deadlineInput.value ? 'Add a due date and time or turn off repeated reminders.' : '');
    if (!form.reportValidity()) return;
    let recurrence = null;
    if (repeatWeeklyField.checked) {
      const draft = {
        cadence: 'weekly',
        timeZone: recurrenceTimeZoneField.value.trim(),
        weekStartsOn: recurrenceWeekStartsOnField.value === '' ? NaN : Number(recurrenceWeekStartsOnField.value),
        startsOn: recurrenceStartsOnField.value,
      };
      const errors = validateWeeklyRecurrence(draft);
      if (errors.length) {
        const error = errors[0];
        const field = /timeZone/.test(error) ? recurrenceTimeZoneField : /weekStartsOn/.test(error) ? recurrenceWeekStartsOnField : recurrenceStartsOnField;
        field.setCustomValidity(error);
        field.reportValidity();
        field.setCustomValidity('');
        return;
      }
      recurrence = createWeeklyRecurrence(draft);
    }
    const taskDate = schedule === 'today' && !recurrence
      ? todayKey()
      : schedule === 'date' && !recurrence
        ? scheduledDateField.value
        : '';
    const durationMinutes = Math.max(0, Number(formValue(form, 'duration')) || 0);
    const startTime = taskDate ? formValue(form, 'startTime') : '';
    if (taskDate && startTime && durationMinutes > 0) {
      const validation = validatePlanningTask({ scheduledDate: taskDate, startTime, durationMinutes }, {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      });
      if (!validation.valid) {
        const timeField = form.elements.namedItem('startTime');
        timeField.setCustomValidity(validation.errors[0]);
        timeField.reportValidity();
        timeField.setCustomValidity('');
        return;
      }
    }
    const reminderChanged = !task || task.departureTime !== departureInput.value || task.leaveLeadMinutes !== Math.max(1, Number(formValue(form, 'leadMinutes')) || 2) || task.leaveReminderEnabled !== reminderEnabled;
    const persistentReminderChanged = !task || toLocalInput(task.deadline ?? '') !== deadlineInput.value || Boolean(task.persistentReminderEnabled) !== persistentReminderEnabled;
    const updated = {
      ...(task ?? { id: makeId('task'), status: 'open' }),
      title: formValue(form, 'title').trim(),
      durationMinutes,
      category: formValue(form, 'category').trim(),
      scheduledDate: taskDate,
      scheduleWindow: recurrence || schedule === 'week' ? 'this-week' : '',
      startTime,
      deadline: formValue(form, 'deadline'),
      persistentReminderEnabled,
      persistentReminderNextAt: persistentReminderChanged ? null : task?.persistentReminderNextAt ?? null,
      nextStep: formValue(form, 'nextStep').trim(),
      departureTime: formValue(form, 'departureTime'),
      leaveReminderEnabled: form.elements.namedItem('leaveReminder').checked,
      leaveLeadMinutes: Math.max(1, Math.min(180, Number(formValue(form, 'leadMinutes')) || 2)),
      leaveDelivery: formValue(form, 'delivery'),
      reminderDismissed: reminderChanged ? false : Boolean(task?.reminderDismissed),
      reminderSentAt: reminderChanged ? null : task?.reminderSentAt ?? null,
      snoozeUntil: reminderChanged ? null : task?.snoozeUntil ?? null,
      status: recurrence ? 'open' : task?.status ?? 'open',
    };
    if (recurrence) {
      updated.recurrence = recurrence;
      // A keyed object lets the sync model merge distinct weekly completions independently.
      updated.recurrenceCompletions = task?.recurrenceCompletions ?? {};
    } else {
      delete updated.recurrence; // Keep completion history if recurrence is turned off.
    }
    if (task) state = { ...state, tasks: state.tasks.map((item) => item.id === task.id ? updated : item) };
    else state = { ...state, tasks: [...state.tasks, updated] };
    if (updated.leaveReminderEnabled && updated.leaveDelivery === 'system' && 'Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch { /* In-app reminders still work while this page is open. */ }
    }
    saveLocalState(state);
    dialog.close();
    showToast(doc, 'Saved on this device.');
    syncScreen();
  });
  dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
  dialog.querySelector('[data-manage-subtasks]')?.addEventListener('click', () => openSubtaskManager(doc, task));
  dialog.querySelector('[data-make-now]')?.addEventListener('click', () => {
    state = { ...state, currentTaskId: task.id };
    persist();
    dialog.close();
    routeTo('today');
  });
  dialog.querySelector('[data-toggle-complete]')?.addEventListener('click', () => {
    if (task.recurrence) {
      const current = currentWeeklyTaskState(task);
      if (!current?.valid || current.beforeStart || current.completed) return;
      let result;
      try {
        result = recordWeeklyCompletion(task.recurrence, weeklyCompletionList(task), new Date());
      } catch {
        showToast(doc, 'Weekly completion history needs review before it can be changed.');
        return;
      }
      if (!result.added) {
        showToast(doc, result.reason === 'already-completed' ? 'This weekly window is already complete.' : 'This weekly window has not started yet.');
        return;
      }
      state = { ...state, tasks: state.tasks.map((item) => item.id === task.id ? { ...item, status: 'open', recurrenceCompletions: weeklyCompletionMap(result.completions) } : item) };
      persist();
      dialog.close();
      showToast(doc, `Marked complete for the week of ${result.completion.windowStart}.`);
      return;
    }
    state = { ...state, tasks: state.tasks.map((item) => item.id === task.id ? { ...item, status: item.status === 'done' ? 'open' : 'done', completedAt: item.status === 'done' ? null : new Date().toISOString() } : item) };
    persist();
    dialog.close();
    showToast(doc, state.tasks.find((item) => item.id === task.id)?.status === 'done' ? 'Task completed.' : 'Task reopened.');
  });
  dialog.querySelectorAll('[data-move]').forEach((button) => button.addEventListener('click', () => {
    state = task.parentTaskId
      ? reorderSubtask(state, task.parentTaskId, task.id, index + Number(button.dataset.move))
      : reorderCaptureTask(state, task.parentCaptureId, task.id, Number(button.dataset.move));
    persist();
    dialog.close();
    showToast(doc, 'Subtask order updated.');
  }));
  dialog.querySelector('[data-remove]')?.addEventListener('click', () => {
    dialog.close();
    if (task.parentTaskId) {
      state = removeSubtask(state, task.id);
      persist();
      showUndoToast(doc, 'Subtask removed.', () => {
        state = undoRemoveSubtask(state, task.id);
        persist();
        showToast(doc, 'Subtask restored.');
      });
    } else {
      state = removeTask(state, task.id);
      persist();
      showToast(doc, 'Subtask removed. The original capture is still saved.');
    }
  });
  dialog.showModal();
  form.elements.namedItem('title').focus();
}

function refreshTaskSubtaskSummary(doc, parentTask) {
  const host = doc.querySelector('#tempo-task-dialog [data-task-subtask-summary]');
  if (!host) return;
  host.replaceChildren();
  const children = getSubtasks(state, parentTask.id);
  if (children.length === 0) {
    const empty = doc.createElement('p');
    empty.textContent = 'No linked steps yet.';
    host.append(empty);
    return;
  }
  const list = doc.createElement('ol');
  children.forEach((child) => {
    const item = doc.createElement('li');
    item.textContent = child.title;
    list.append(item);
  });
  host.append(list);
}

function ensureSubtaskDialog(doc) {
  let dialog = doc.querySelector('#tempo-subtask-dialog');
  if (dialog) return dialog;
  dialog = doc.createElement('dialog');
  dialog.id = 'tempo-subtask-dialog';
  dialog.className = 'tempo-dialog';
  dialog.setAttribute('aria-labelledby', 'tempo-subtask-title');
  doc.body.append(dialog);
  return dialog;
}

function openSubtaskManager(doc, parentTask) {
  const dialog = ensureSubtaskDialog(doc);
  let proposal = null;
  let manualText = '';

  const readDraftTitles = (allowBlankId = '') => {
    if (!proposal) return true;
    const inputs = [...dialog.querySelectorAll('[data-draft-title]')];
    const blank = inputs.find((input) => !input.value.trim() && input.dataset.draftTitle !== allowBlankId);
    if (blank) {
      blank.setCustomValidity('Enter a title or remove this step.');
      blank.reportValidity();
      blank.focus();
      return false;
    }
    for (const input of inputs) {
      input.setCustomValidity('');
      proposal = editProposedSubtask(proposal, input.dataset.draftTitle, input.value);
    }
    return true;
  };

  const saveAndRefresh = () => {
    persist();
    refreshTaskSubtaskSummary(doc, parentTask);
  };

  const render = () => {
    const children = getSubtasks(state, parentTask.id);
    const childMarkup = children.length
      ? `<ol>${children.map((child, index) => `
          <li class="tempo-subtask-item">
            <label>Step ${index + 1}<input type="text" maxlength="160" data-child-title="${escapeHtml(child.id)}" value="${escapeHtml(child.title)}" aria-label="Step ${index + 1} title"></label>
            <div class="actions">
              <button type="button" class="primary" data-child-save="${escapeHtml(child.id)}">Save</button>
              <button type="button" data-child-move="up" data-child-id="${escapeHtml(child.id)}" ${index === 0 ? 'disabled' : ''}>Move up</button>
              <button type="button" data-child-move="down" data-child-id="${escapeHtml(child.id)}" ${index === children.length - 1 ? 'disabled' : ''}>Move down</button>
              <button type="button" class="danger" data-child-remove="${escapeHtml(child.id)}">Remove</button>
            </div>
          </li>`).join('')}</ol>`
      : '<div class="tempo-subtask-empty">No active subtasks. Add a manual list when you are ready.</div>';
    const proposalMarkup = proposal
      ? `<section aria-labelledby="tempo-proposal-heading">
          <div><h3 id="tempo-proposal-heading">Review proposed steps</h3><p>Only these titles will be added. New steps start unscheduled with no estimate or due date.</p></div>
          <ol>${proposal.items.map((item, index) => `
            <li class="tempo-subtask-item">
              <label>Step ${index + 1}<input type="text" maxlength="160" required data-draft-title="${escapeHtml(item.id)}" value="${escapeHtml(item.title)}" aria-label="Proposed step ${index + 1}"></label>
              <div class="actions">
                <button type="button" data-draft-move="up" data-draft-id="${escapeHtml(item.id)}" ${index === 0 ? 'disabled' : ''}>Move up</button>
                <button type="button" data-draft-move="down" data-draft-id="${escapeHtml(item.id)}" ${index === proposal.items.length - 1 ? 'disabled' : ''}>Move down</button>
                <button type="button" class="danger" data-draft-remove="${escapeHtml(item.id)}">Remove</button>
              </div>
            </li>`).join('')}</ol>
          <label>Add another step<input type="text" maxlength="160" data-add-draft-title aria-label="New proposed step title"></label>
          <div class="actions">
            <button type="button" data-add-draft>Add step</button>
            <button type="button" data-undo-draft ${proposal.removed.length ? '' : 'disabled'}>Undo removed step</button>
          </div>
          <div class="actions">
            <button type="button" data-cancel-proposal>Cancel proposal</button>
            <button type="button" class="primary" data-accept-proposal>Accept steps</button>
          </div>
        </section>`
      : `<section aria-labelledby="tempo-proposal-heading">
          <div><h3 id="tempo-proposal-heading">Add steps manually</h3><p>Enter one step per line. Nothing is generated from the parent task.</p></div>
          <label>Step titles<textarea rows="4" maxlength="1200" data-manual-steps aria-label="Enter subtask titles, one per line">${escapeHtml(manualText)}</textarea></label>
          <div class="actions"><button type="button" class="primary" data-review-proposal>Review steps</button></div>
        </section>`;

    dialog.innerHTML = `
      <div class="tempo-subtask-manager">
        <header><h2 id="tempo-subtask-title">Steps for ${escapeHtml(parentTask.title)}</h2><p>These stay linked to the parent task. Its completion status will not change.</p></header>
        <section aria-labelledby="tempo-current-steps-heading">
          <div><h3 id="tempo-current-steps-heading">Current steps</h3><p>Edit titles, change order, or remove a step. You can undo a removal.</p></div>
          ${childMarkup}
        </section>
        ${proposalMarkup}
        <div class="actions"><button type="button" data-close-subtask-manager>Done</button></div>
      </div>`;

    dialog.querySelector('[data-review-proposal]')?.addEventListener('click', () => {
      const textarea = dialog.querySelector('[data-manual-steps]');
      manualText = textarea.value;
      const titles = manualText.split(/\r?\n/);
      const nextProposal = createSubtaskProposal(state, parentTask.id, titles);
      if (nextProposal.items.length === 0) {
        showToast(doc, 'Enter at least one step, then review the list.');
        textarea.focus();
        return;
      }
      proposal = nextProposal;
      render();
      dialog.querySelector('[data-draft-title]')?.focus();
    });

    dialog.querySelectorAll('[data-child-save]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.childSave;
      const input = dialog.querySelector(`[data-child-title="${CSS.escape(id)}"]`);
      if (!input.value.trim()) {
        input.setCustomValidity('Enter a title for this step.');
        input.reportValidity();
        input.focus();
        return;
      }
      input.setCustomValidity('');
      state = editSubtask(state, id, input.value);
      saveAndRefresh();
      render();
      showToast(doc, 'Step saved.');
    }));

    dialog.querySelectorAll('[data-child-move]').forEach((button) => button.addEventListener('click', () => {
      const current = getSubtasks(state, parentTask.id);
      const from = current.findIndex((child) => child.id === button.dataset.childId);
      const offset = button.dataset.childMove === 'up' ? -1 : 1;
      state = reorderSubtask(state, parentTask.id, button.dataset.childId, from + offset);
      saveAndRefresh();
      render();
    }));

    dialog.querySelectorAll('[data-child-remove]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.childRemove;
      state = removeSubtask(state, id);
      saveAndRefresh();
      render();
      showUndoToast(doc, 'Subtask removed.', () => {
        state = undoRemoveSubtask(state, id);
        saveAndRefresh();
        render();
        showToast(doc, 'Subtask restored.');
      });
    }));

    dialog.querySelectorAll('[data-draft-move]').forEach((button) => button.addEventListener('click', () => {
      if (!readDraftTitles()) return;
      const index = proposal.items.findIndex((item) => item.id === button.dataset.draftId);
      const offset = button.dataset.draftMove === 'up' ? -1 : 1;
      proposal = reorderProposedSubtask(proposal, button.dataset.draftId, index + offset);
      render();
      dialog.querySelector(`[data-draft-title="${CSS.escape(button.dataset.draftId)}"]`)?.focus();
    }));

    dialog.querySelectorAll('[data-draft-remove]').forEach((button) => button.addEventListener('click', () => {
      if (!readDraftTitles(button.dataset.draftRemove)) return;
      proposal = removeProposedSubtask(proposal, button.dataset.draftRemove);
      render();
    }));

    dialog.querySelector('[data-add-draft]')?.addEventListener('click', () => {
      if (!readDraftTitles()) return;
      const input = dialog.querySelector('[data-add-draft-title]');
      if (!input.value.trim()) {
        input.setCustomValidity('Enter a title for the new step.');
        input.reportValidity();
        input.focus();
        return;
      }
      proposal = addProposedSubtask(proposal, input.value);
      render();
      dialog.querySelector(`[data-draft-title="${CSS.escape(proposal.items.at(-1).id)}"]`)?.focus();
    });

    dialog.querySelector('[data-undo-draft]')?.addEventListener('click', () => {
      if (!readDraftTitles()) return;
      proposal = undoProposedSubtaskRemoval(proposal);
      render();
    });

    dialog.querySelector('[data-cancel-proposal]')?.addEventListener('click', () => {
      manualText = [...dialog.querySelectorAll('[data-draft-title]')].map((input) => input.value).join('\n');
      state = cancelSubtaskProposal(state);
      proposal = null;
      render();
      dialog.querySelector('[data-manual-steps]')?.focus();
    });

    dialog.querySelector('[data-accept-proposal]')?.addEventListener('click', () => {
      if (!readDraftTitles()) return;
      if (proposal.items.length === 0) {
        showToast(doc, 'Add at least one step before accepting.');
        return;
      }
      try {
        const result = commitSubtaskProposal(state, proposal, proposal.items.map(() => makeId('task')));
        state = result.state;
        saveAndRefresh();
        dialog.close();
        showToast(doc, `Added ${result.tasks.length} steps. Parent completion unchanged.`);
      } catch (error) {
        showToast(doc, error.message || 'Could not add these steps. Review the list and try again.');
      }
    });

    dialog.querySelector('[data-close-subtask-manager]')?.addEventListener('click', () => dialog.close());
  };

  render();
  if (!dialog.open) dialog.showModal();
}

function showUndoToast(doc, message, onUndo) {
  if (!doc?.body) return;
  let toast = doc.querySelector('.tempo-toast');
  if (!toast) {
    toast = doc.createElement('div');
    toast.className = 'tempo-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    doc.body.append(toast);
  }
  toast.replaceChildren(doc.createTextNode(message));
  const undo = doc.createElement('button');
  undo.type = 'button';
  undo.className = 'tempo-toast-undo';
  undo.textContent = 'Undo';
  undo.setAttribute('aria-label', 'Undo removal');
  undo.addEventListener('click', () => {
    window.clearTimeout(toastTimer);
    toast.remove();
    onUndo();
  });
  toast.append(undo);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.remove(), 5500);
}

function toLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function startOfWeekKey(date) {
  const day = new Date(date);
  const delta = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - delta);
  return todayKey(day);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function row(doc, task, actions = true) {
  const swipe = doc.createElement('div');
  swipe.className = 'tempo-task-swipe';
  const wrapper = doc.createElement('div');
  wrapper.className = 'tempo-task-row';
  if (task.parentCaptureId) wrapper.setAttribute('aria-label', 'Subtask linked to a saved capture');
  else if (task.parentTaskId) wrapper.setAttribute('aria-label', 'Subtask linked to a parent task');
  const button = doc.createElement('button');
  button.type = 'button';
  button.setAttribute('aria-label', `Edit ${task.title}`);
  const title = doc.createElement('span');
  title.textContent = task.title;
  const details = doc.createElement('small');
  const baseDetails = `${task.parentTaskId ? 'Subtask · ' : ''}${task.category ? `${task.category} · ` : ''}${task.durationMinutes ? `${task.durationMinutes} min` : 'No time set'}`;
  const weeklyState = task.recurrence ? currentWeeklyTaskState(task) : null;
  const weeklyDetails = !weeklyState ? '' : !weeklyState.valid
    ? 'Weekly settings need review'
    : weeklyState.beforeStart
      ? `Weekly · first window starts ${task.recurrence.startsOn}`
      : weeklyState.completed
        ? `Weekly · complete for window starting ${weeklyState.window.startDate}`
        : `Weekly · ${weeklyState.window.startDate} to ${weeklyState.window.endDate}`;
  details.textContent = [baseDetails, weeklyDetails].filter(Boolean).join(' · ');
  button.append(title, details);
  button.addEventListener('click', () => {
    if (swipe.classList.contains('is-revealed')) {
      swipe.classList.remove('is-revealed');
      return;
    }
    openTaskDialog(doc, task);
  });
  wrapper.append(button);
  if (actions) {
    const edit = doc.createElement('span');
    edit.className = 'edit-label';
    edit.textContent = weeklyState
      ? !weeklyState.valid ? 'Review' : weeklyState.completed ? 'Complete' : weeklyState.beforeStart ? 'Starts later' : 'This week'
      : task.status === 'done' ? 'Completed' : task.scheduledDate === todayKey() ? (task.startTime || 'Today') : task.scheduledDate ? `${task.scheduledDate}${task.startTime ? ` · ${task.startTime}` : ''}` : task.scheduleWindow === 'this-week' ? 'This week' : 'Later';
    wrapper.append(edit);

    const remove = doc.createElement('button');
    remove.type = 'button';
    remove.className = 'tempo-task-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${task.title}`);
    remove.addEventListener('focus', () => swipe.classList.add('is-revealed'));
    remove.addEventListener('blur', () => {
      if (!swipe.contains(doc.activeElement)) swipe.classList.remove('is-revealed');
    });
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      const current = state.tasks.find((item) => item.id === task.id);
      if (!current || current.status === 'removed') return;
      state = removeTask(state, current.id);
      saveLocalState(state);
      showUndoToast(doc, 'Task removed.', () => {
        state = { ...state, tasks: state.tasks.map((item) => item.id === current.id ? current : item) };
        saveLocalState(state);
        syncScreen();
      });
      syncScreen();
    });
    swipe.append(remove);

    let startX = null;
    let startY = null;
    let pointerId = null;
    let didSwipe = false;
    swipe.addEventListener('pointerdown', (event) => {
      if (event.target.closest('button.tempo-task-remove')) return;
      startX = event.clientX;
      startY = event.clientY;
      pointerId = event.pointerId;
      didSwipe = false;
    });
    swipe.addEventListener('pointerup', (event) => {
      if (pointerId !== event.pointerId || startX === null) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        didSwipe = true;
        if (dx < 0) {
          doc.querySelectorAll('.tempo-task-swipe.is-revealed').forEach((item) => item.classList.remove('is-revealed'));
          swipe.classList.add('is-revealed');
        } else swipe.classList.remove('is-revealed');
      }
      startX = startY = pointerId = null;
    });
    swipe.addEventListener('pointercancel', () => { startX = startY = pointerId = null; });
    button.addEventListener('click', (event) => {
      if (!didSwipe) return;
      event.stopImmediatePropagation();
      didSwipe = false;
    }, true);
  }
  swipe.append(wrapper);
  return swipe;
}

function setInteractive(element, label, handler) {
  if (!element) return;
  element.classList.add('tempo-accessible-action');
  element.setAttribute('role', 'button');
  element.tabIndex = 0;
  element.setAttribute('aria-label', label);
  element.addEventListener('click', handler);
  if (element.tagName !== 'BUTTON' && element.tagName !== 'A') element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handler(); }
  });
}

function bindTaskElement(element, task) {
  if (!element) return;
  element.dataset.taskId = task.id;
  element.setAttribute('aria-label', `Edit ${task.title}`);
  element.setAttribute('role', 'button');
  element.tabIndex = 0;
  element.classList.add('tempo-accessible-action');
  if (element.dataset.taskActionBound) return;
  element.dataset.taskActionBound = 'true';
  const open = () => {
    const current = state.tasks.find((item) => item.id === element.dataset.taskId);
    if (current && current.status !== 'removed') openTaskDialog(docOf(element), current);
  };
  element.addEventListener('click', open);
  element.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
  });
}

function docOf(element) {
  return element.ownerDocument;
}

function byText(doc, text, selector = '*') {
  return [...doc.querySelectorAll(selector)].find((el) => el.children.length === 0 && el.textContent.trim() === text);
}

function configurePlanScreen(doc, wide) {
  if (state.demoData) {
    // Keep the sample reference layout intact while making its task controls live.
  } else {
    renderCurrentPlan(doc, wide);
  }
  doc.querySelectorAll('button').forEach((button) => {
    if (button.textContent.trim() !== '+3 more') return;
    button.classList.add('tempo-more-action');
    button.setAttribute('aria-label', 'Open Plan to view remaining tasks');
    button.title = 'Open Plan to view remaining tasks';
    button.addEventListener('click', () => routeTo('plan'));
  });
  const tasksByTitle = new Map(activeTasks().map((task) => [task.title, task]));
  for (const element of doc.querySelectorAll('span,div')) {
    if (element.children.length) continue;
    const task = tasksByTitle.get(element.textContent.trim());
    if (task) bindTaskElement(element, task);
  }
  doc.querySelectorAll('button').forEach((button) => {
    if (button.textContent.trim() === 'Start 25-min focus') button.addEventListener('click', () => startFocus(doc));
    if (button.textContent.trim() === 'Stuck?') button.addEventListener('click', () => {
      const selected = state.tasks.find((task) => task.id === state.currentTaskId) || state.tasks.find((task) => task.id === 'budget');
      openTaskDialog(doc, selected);
    });
  });
}

function makeReferenceRowsEditable(doc) {
  const current = state.tasks.find((task) => task.id === (state.currentTaskId || 'budget'));
  if (!current) return;
  for (const element of doc.querySelectorAll('div,span')) {
    if (element.children.length === 0 && element.textContent.trim() === 'Draft the budget summary') {
      bindTaskElement(element, current);
    }
  }
}

function renderCurrentPlan(doc, wide) {
  const tasks = activeTasks().filter(task => task.status === 'open');
  const nowTask = tasks.find(task => task.id === state.currentTaskId)
    || tasks.find(task => task.scheduledDate === todayKey());
  const todayList = visibleTodayTasks().filter(task => task.id !== nowTask?.id).sort(taskOrder);
  if (screenName === 'week') {
    renderLiveWeek(doc, wide);
    return;
  }
  const root = doc.body.firstElementChild;
  if (!root) return;
  const date = new Date();
  for (const el of doc.querySelectorAll('span')) {
    const text = el.textContent.trim();
    if (text === 'Thursday') el.textContent = new Intl.DateTimeFormat(undefined,{weekday:'long'}).format(date);
    if (text === '29 October') el.textContent = new Intl.DateTimeFormat(undefined,{day:'numeric',month:'long'}).format(date);
    if (text === '5 h 40 min') el.textContent = 'Not set';
    if (text.startsWith('Start the budget by') || text.startsWith('Budget ends 14:45')) el.textContent = 'Time guidance is not available yet.';
  }
  const nowLabel = byText(doc, 'NOW', 'span');
  const card = nowLabel?.parentElement;
  if (card) {
    const title = card.children[1];
    const details = card.children[2];
    if (title) { title.textContent = nowTask?.title ?? 'Choose a task to begin'; if (nowTask) bindTaskElement(title,nowTask); }
    if (details) details.textContent = nowTask ? [nowTask.durationMinutes ? `${nowTask.durationMinutes} min` : 'No estimate', nowTask.deadline ? `Due ${new Date(nowTask.deadline).toLocaleString()}` : ''].filter(Boolean).join(' · ') : 'Add or choose a task in Plan';
    card.querySelectorAll('button').forEach(button => {button.disabled = !nowTask;});
  }
  const queueLabel = byText(doc, 'Queue, sized by time', 'span');
  if (queueLabel?.nextElementSibling) {
    const queue = queueLabel.nextElementSibling; queue.replaceChildren();
    const scheduled = [nowTask, ...todayList].filter(task => task && task.durationMinutes > 0);
    if (!scheduled.length) queue.textContent = 'No estimated task times yet.';
    scheduled.forEach((task, index) => {
      const item = doc.createElement('div'); item.textContent = task.title;
      item.style.cssText = `flex:${task.durationMinutes} 1 0;min-width:0;overflow:hidden;border-radius:8px;padding:8px;background:${index ? '#C9D6EA' : '#2B5FC4'};color:${index ? '#1B2430' : '#fff'};font-size:13px`;
      queue.append(item);
    });
  }
  const timeline = [...doc.querySelectorAll('h2')].find(el => el.textContent.trim() === 'Timeline, blocks sized by time');
  if (timeline?.nextElementSibling) {
    const area = timeline.nextElementSibling; area.replaceChildren();
    area.style.cssText = 'position:relative;height:720px;padding-left:64px';
    try {
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const day = buildDayPlan(tasks, todayKey(), {timeZone:zone, now:new Date()});
      const axis = doc.createElement('div'); axis.style.cssText='position:absolute;left:0;top:0;width:52px;font-size:13px;color:#4A5565;font-variant-numeric:tabular-nums';
      for (let hour=9;hour<=19;hour++) { const label=doc.createElement('div'); label.textContent=`${String(hour).padStart(2,'0')}:00`; label.style.cssText=`position:absolute;top:${(hour-9)*72-8}px;right:0`; axis.append(label); }
      const grid=doc.createElement('div'); grid.style.cssText='position:absolute;left:64px;right:0;top:0;height:720px;background:repeating-linear-gradient(to bottom,#E1E6EE 0,#E1E6EE 1px,transparent 1px,transparent 72px)';
      area.append(axis,grid);
      const lanes=[];
      for (const item of day.timedTasks) {
        const start = new Date(item.startAt).getTime(), end = new Date(item.endAt).getTime();
        let lane = lanes.findIndex(lastEnd => lastEnd <= start); if (lane < 0) lane=lanes.length; lanes[lane]=end;
        item.displayLane=lane;
      }
      const columns=Math.max(1,lanes.length);
      for (const item of day.timedTasks) {
        const button=doc.createElement('button'); button.type='button'; button.textContent=`${item.title}, ${item.task.startTime}, ${item.durationMinutes} min`;
        button.setAttribute('aria-label',`${item.title}, ${item.task.startTime}, ${item.durationMinutes} minutes`);
        button.style.cssText=`position:absolute;top:${item.topFraction*720}px;height:${Math.max(1,item.heightFraction*720)}px;left:calc(72px + (100% - 72px)*${item.displayLane/columns});width:calc((100% - 72px)/${columns} - 4px);padding:0 6px;overflow:hidden;text-align:left;border:0;border-radius:8px;background:#E4ECF8;color:#1B2430;font:inherit;font-size:13px`;
        button.addEventListener('click',()=>openTaskDialog(doc,item.task)); area.append(button);
      }
      const missing = day.untimedTasks.length + day.offTimelineTasks.length + day.invalidTasks.length;
      if (missing) { const note=doc.createElement('p'); note.textContent=`${missing} scheduled item(s) cannot be shown on this timeline. Review them in Plan.`; note.style.cssText='position:absolute;top:725px;left:64px;font-size:13px;color:#4A5565'; area.append(note); }
    } catch {
      const note=doc.createElement('p'); note.textContent='Timeline unavailable for this date or time zone. Review tasks in Plan.'; area.append(note);
    }
  }
  const upNextTitle = byText(doc, 'Up next', 'span');
  if (upNextTitle?.parentElement) {
    const parent = upNextTitle.parentElement;
    [...parent.children].forEach(node => { if (node !== upNextTitle) node.remove(); });
    const list = doc.createElement('div'); list.className = 'tempo-list';
    todayList.slice(0,5).forEach(task => list.append(row(doc,task)));
    if (!todayList.length) { const empty=doc.createElement('div'); empty.textContent='No more tasks scheduled for today.'; list.append(empty); }
    const review=doc.createElement('button'); review.type='button'; review.textContent='Add or review tasks';
    review.style.cssText='min-height:44px;border:1px dashed #8A96A8;border-radius:10px;background:transparent;color:#1B2430;font:inherit';
    review.addEventListener('click',()=>routeTo('plan')); parent.append(list,review);
  }
}

function renderLiveWeek(doc, wide, focusAction = '') {
  const main = doc.querySelector('main');
  if (!main) return;
  const mobileSettingsLink = wide ? null : main.querySelector('.settings-link');
  const mobileNavigation = wide ? null : main.querySelector('nav.nav');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const now = new Date();
  let plan;
  try {
    plan = buildWeekPlan(state.tasks, liveWeekStartDate ?? todayKey(), {
      timeZone,
      weekStartsOn: 1,
      timelineStart: '09:00',
      timelineEnd: '19:00',
      now,
    });
  } catch {
    renderUnavailableWeek(doc, main, wide, mobileSettingsLink, mobileNavigation);
    return;
  }
  liveWeekStartDate = plan.startDate;
  const shownDays = liveWeekShowWeekend ? plan.days.slice(5) : plan.days.slice(0, 5);
  const visibleRange = [shownDays[0].date, shownDays.at(-1).date];
  main.replaceChildren();
  main.style.gap = '20px';

  const header = doc.createElement('div');
  header.className = 'tempo-week-header';
  header.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:12px';
  header.setAttribute('aria-live', 'polite');
  const headingGroup = doc.createElement('div');
  headingGroup.style.cssText = 'display:flex;flex-direction:column;gap:4px';
  const context = doc.createElement('span');
  context.textContent = 'Week of';
  context.style.cssText = 'font-size:14px;color:#4A5565;letter-spacing:.04em;text-transform:uppercase';
  const title = doc.createElement('h1');
  title.id = 'tempo-live-week-heading';
  title.style.cssText = 'margin:0;font-size:30px;font-weight:700';
  title.textContent = formatPlannerDateRange(...visibleRange);
  headingGroup.append(context, title);
  const note = doc.createElement('p');
  note.style.cssText = 'max-width:420px;margin:0;color:#4A5565;font-size:15px';
  note.textContent = 'Blocks use their real times and lengths. A full capacity bar represents eight booked hours.';
  header.append(headingGroup, note);

  const toolbar = doc.createElement('div');
  toolbar.className = 'tempo-week-toolbar';
  toolbar.setAttribute('aria-label', 'Week navigation and actions');
  const previous = createWeekButton(doc, 'Previous week', 'previous', () => {
    liveWeekStartDate = plan.previousStartDate;
    renderLiveWeek(doc, wide, 'previous');
  });
  previous.setAttribute('aria-label', `Previous week, before ${formatPlannerDate(plan.startDate, { month: 'long', day: 'numeric' })}`);
  const dateLabel = doc.createElement('label');
  dateLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700';
  dateLabel.textContent = 'Go to date';
  const dateInput = doc.createElement('input');
  dateInput.type = 'date';
  dateInput.setAttribute('aria-label', 'Go to a date in another week');
  dateInput.value = plan.startDate;
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    try {
      liveWeekStartDate = buildWeekPlan(state.tasks, dateInput.value, { timeZone, weekStartsOn: 1, now }).startDate;
      renderLiveWeek(doc, wide, 'date');
    } catch {
      showToast(doc, 'That date could not be opened. Choose a valid calendar date.');
      dateInput.focus();
    }
  });
  dateLabel.append(dateInput);
  const next = createWeekButton(doc, 'Next week', 'next', () => {
    liveWeekStartDate = plan.nextStartDate;
    renderLiveWeek(doc, wide, 'next');
  });
  next.setAttribute('aria-label', `Next week, after ${formatPlannerDate(plan.endDate, { month: 'long', day: 'numeric' })}`);
  const currentWeek = createWeekButton(doc, 'This week', 'current', () => {
    liveWeekStartDate = null;
    renderLiveWeek(doc, wide, 'current');
  });
  const weekendToggle = createWeekButton(
    doc,
    liveWeekShowWeekend ? 'Show weekdays' : 'Show weekend',
    'weekend',
    () => {
      liveWeekShowWeekend = !liveWeekShowWeekend;
      renderLiveWeek(doc, wide, 'weekend');
    },
  );
  weekendToggle.setAttribute('aria-pressed', String(liveWeekShowWeekend));
  const addTask = createWeekButton(doc, 'Add a task', 'add', () => openTaskDialog(doc), true);
  toolbar.append(previous, dateLabel, next, currentWeek, weekendToggle, addTask);
  if (mobileSettingsLink) toolbar.append(mobileSettingsLink);

  const grid = doc.createElement('div');
  grid.className = `tempo-week-grid${liveWeekShowWeekend ? ' weekend' : ''}`;
  grid.setAttribute('aria-label', liveWeekShowWeekend ? 'Saturday and Sunday' : 'Monday through Friday');
  grid.style.gridTemplateColumns = wide
    ? liveWeekShowWeekend ? 'repeat(2,minmax(170px,1fr))' : 'repeat(5,minmax(170px,1fr))'
    : 'minmax(0,1fr)';
  for (const day of shownDays) grid.append(renderWeekDay(doc, day, timeZone));

  const footer = doc.createElement('section');
  footer.className = 'tempo-week-footer';
  footer.setAttribute('aria-label', 'Tasks without a fixed day');
  appendWeekFooterGroup(doc, footer, 'Flexible this week · choose a day when ready', plan.flexibleTasks);
  appendWeekFooterGroup(doc, footer, 'Later, not scheduled', plan.laterTasks);
  if (!plan.flexibleTasks.length && !plan.laterTasks.length) {
    const empty = doc.createElement('p');
    empty.textContent = 'No tasks are waiting for a day.';
    footer.append(empty);
  }
  main.append(header, toolbar, grid, footer);
  if (mobileNavigation) {
    mobileNavigation.style.position = 'sticky';
    mobileNavigation.style.left = 'auto';
    mobileNavigation.style.right = 'auto';
    mobileNavigation.style.bottom = '0';
    mobileNavigation.style.flexShrink = '0';
    mobileNavigation.style.marginTop = 'auto';
    main.append(mobileNavigation);
  }
  if (focusAction) doc.querySelector(`[data-week-action="${focusAction}"]`)?.focus({ preventScroll: true });
}

function renderUnavailableWeek(doc, main, wide, mobileSettingsLink, mobileNavigation) {
  main.replaceChildren();
  const heading = doc.createElement('h1');
  heading.textContent = 'Week';
  heading.style.margin = '0';
  const message = doc.createElement('p');
  message.textContent = 'This week could not be shown in the selected time zone. Choose another date or return to this week.';
  const toolbar = doc.createElement('div');
  toolbar.className = 'tempo-week-toolbar';
  const dateLabel = doc.createElement('label');
  dateLabel.style.cssText = 'display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700';
  dateLabel.textContent = 'Go to date';
  const input = doc.createElement('input');
  input.type = 'date';
  input.setAttribute('aria-label', 'Go to a date in another week');
  input.value = todayKey();
  input.addEventListener('change', () => {
    if (!input.value) return;
    liveWeekStartDate = input.value;
    renderLiveWeek(doc, wide, 'date');
  });
  dateLabel.append(input);
  const current = createWeekButton(doc, 'This week', 'current', () => {
    liveWeekStartDate = null;
    renderLiveWeek(doc, wide, 'current');
  });
  toolbar.append(dateLabel, current);
  if (mobileSettingsLink) toolbar.append(mobileSettingsLink);
  main.append(heading, message, toolbar);
  if (mobileNavigation) {
    mobileNavigation.style.position = 'sticky';
    mobileNavigation.style.left = 'auto';
    mobileNavigation.style.right = 'auto';
    mobileNavigation.style.bottom = '0';
    mobileNavigation.style.flexShrink = '0';
    mobileNavigation.style.marginTop = 'auto';
    main.append(mobileNavigation);
  }
}

function renderWeekDay(doc, day, timeZone) {
  const card = doc.createElement('section');
  card.className = `tempo-week-day${day.isToday ? ' is-today' : ''}`;
  const headingId = `tempo-week-day-${day.date}`;
  card.setAttribute('aria-labelledby', headingId);

  const header = doc.createElement('div');
  header.className = 'tempo-week-day-head';
  const title = doc.createElement('h2');
  title.id = headingId;
  title.textContent = `${day.weekday}${day.isToday ? ', today' : ''}`;
  const sub = doc.createElement('span');
  sub.className = 'tempo-week-day-summary';
  sub.textContent = `${formatPlannerDate(day.date, { month: 'short', day: 'numeric' })} · ${formatPlannedMinutes(day.bookedMinutes)} booked`;
  header.append(title, sub);

  const capacity = doc.createElement('div');
  capacity.className = 'tempo-week-capacity';
  capacity.setAttribute('role', 'img');
  const ratio = Math.round(day.bookedMinutes / 480 * 100);
  capacity.setAttribute('aria-label', `${ratio}% of an eight-hour day booked`);
  const fill = doc.createElement('span');
  fill.style.width = `${Math.min(100, ratio)}%`;
  capacity.append(fill);
  const capacityNote = doc.createElement('span');
  capacityNote.className = 'tempo-week-capacity-note';
  capacityNote.textContent = day.bookedMinutes === 0
    ? 'Open, 0% of an 8-hour day'
    : day.bookedMinutes > 480
      ? `${formatPlannedMinutes(day.bookedMinutes - 480)} beyond an 8-hour day`
      : `${ratio >= 65 ? 'Full' : 'Light'}, ${ratio}% of an 8-hour day`;

  const clockRange = doc.createElement('span');
  clockRange.className = 'tempo-week-clock-range';
  clockRange.textContent = '09:00–19:00';
  const track = doc.createElement('div');
  track.className = 'tempo-week-track';
  track.setAttribute('aria-label', `Timed tasks from 09:00 to 19:00 in ${timeZone}`);
  for (const gap of day.gaps) {
    if (gap.durationMinutes < 45) continue;
    const open = doc.createElement('div');
    open.className = 'tempo-week-open-gap';
    open.setAttribute('aria-hidden', 'true');
    open.style.top = `${gap.topFraction * 400}px`;
    open.style.height = `${gap.heightFraction * 400}px`;
    if (gap.durationMinutes >= 60) {
      const label = doc.createElement('span');
      label.textContent = `Open · ${formatPlannedMinutes(gap.durationMinutes)}`;
      open.append(label);
    }
    track.append(open);
  }
  const positioned = day.timedTasks.map((item) => ({ ...item }));
  const lanes = [];
  for (const item of positioned) {
    const start = Date.parse(item.startAt);
    const end = Date.parse(item.endAt);
    let lane = lanes.findIndex((lastEnd) => lastEnd <= start);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = end;
    item.displayLane = lane;
  }
  const columns = Math.max(1, lanes.length);
  for (const item of positioned) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = `tempo-week-event${item.task.status === 'done' ? ' status-done' : ''}${day.isToday ? ' is-today' : ''}`;
    const readableTime = `${item.task.startTime} · ${item.title}, ${item.durationMinutes} min`;
    button.textContent = item.visibleDurationMinutes < 24
      ? item.task.startTime
      : item.visibleDurationMinutes < 50
        ? `${item.task.startTime} · ${item.title}`
        : readableTime;
    button.title = readableTime;
    button.setAttribute('aria-label', `${readableTime}${item.ambiguousStartTime ? ', repeated local time uses the earlier occurrence' : ''}`);
    button.style.top = `${item.topFraction * 400}px`;
    button.style.height = `${Math.max(1, item.heightFraction * 400)}px`;
    button.style.left = `calc(${item.displayLane / columns * 100}% + 2px)`;
    button.style.width = `calc(${100 / columns}% - 4px)`;
    button.addEventListener('click', () => openTaskDialog(doc, item.task));
    track.append(button);
  }

  const extras = [
    ...day.untimedTasks.map((task) => ({ task, label: task.startTime ? `${task.startTime} · no duration estimate` : 'No start time' })),
    ...day.offTimelineTasks.map(({ task }) => ({ task, label: `${task.startTime} · outside timeline` })),
    ...day.invalidTasks.map(({ task, errors }) => ({ task, label: `Needs schedule review · ${errors[0]}` })),
  ];
  const extraGroup = doc.createElement('div');
  extraGroup.className = 'tempo-week-extra';
  const extraHeading = doc.createElement('h3');
  extraHeading.textContent = extras.length ? 'Scheduled without a visible block' : day.scheduledTasks.length ? 'Tasks shown by time' : 'No tasks planned';
  extraGroup.append(extraHeading);
  if (extras.length) {
    for (const entry of extras) extraGroup.append(createWeekTaskLink(doc, entry.task, entry.label));
  } else if (day.scheduledTasks.length) {
    for (const task of day.scheduledTasks) {
      if (task.status === 'removed') continue;
      const label = task.startTime ? `${task.startTime} · ${task.durationMinutes || 0} min` : 'No start time';
      extraGroup.append(createWeekTaskLink(doc, task, label));
    }
  } else {
    const empty = doc.createElement('p');
    empty.style.cssText = 'margin:0;color:#4A5565;font-size:14px';
    empty.textContent = 'Place a task here when you are ready.';
    extraGroup.append(empty);
  }
  card.append(header, capacity, capacityNote, clockRange, track, extraGroup);
  return card;
}

function createWeekButton(doc, label, action, handler, primary = false) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.dataset.weekAction = action;
  if (primary) button.classList.add('primary');
  button.addEventListener('click', handler);
  return button;
}

function createWeekTaskLink(doc, task, detail) {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'tempo-week-task-link';
  button.textContent = `${task.title} · ${detail}`;
  button.setAttribute('aria-label', `Edit ${task.title}. ${detail}.`);
  button.addEventListener('click', () => openTaskDialog(doc, task));
  return button;
}

function appendWeekFooterGroup(doc, footer, label, tasks) {
  const paragraph = doc.createElement('p');
  const heading = doc.createElement('strong');
  heading.textContent = `${label}: `;
  paragraph.append(heading);
  if (!tasks.length) {
    paragraph.append(doc.createTextNode('None.'));
  } else {
    tasks.forEach((task, index) => {
      if (index) paragraph.append(doc.createTextNode(', '));
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = task.title;
      button.setAttribute('aria-label', `Edit ${task.title}`);
      button.addEventListener('click', () => openTaskDialog(doc, task));
      paragraph.append(button);
    });
  }
  footer.append(paragraph);
}

function formatPlannedMinutes(minutes) {
  const value = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(value / 60);
  const remainder = value % 60;
  if (!hours) return `${remainder} min`;
  if (!remainder) return `${hours} h`;
  return `${hours} h ${remainder} min`;
}

function formatPlannerDate(date, options) {
  const [year, month, day] = date.split('-').map(Number);
  const instant = new Date(Date.UTC(year, month - 1, day, 12));
  return new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...options }).format(instant);
}

function formatPlannerDateRange(start, end) {
  const startInstant = new Date(`${start}T12:00:00.000Z`);
  const endInstant = new Date(`${end}T12:00:00.000Z`);
  const formatter = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return typeof formatter.formatRange === 'function'
    ? formatter.formatRange(startInstant, endInstant)
    : `${formatter.format(startInstant)} – ${formatter.format(endInstant)}`;
}

function taskOrder(a, b) {
  return (a.startTime || '99:99').localeCompare(b.startTime || '99:99') || a.title.localeCompare(b.title);
}

function configureMobilePlan(doc) {
  renderMobilePlanLists(doc);
  doc.querySelector('#add-task')?.addEventListener('click', () => openTaskDialog(doc));
}

function renderMobilePlanLists(doc) {
  const today = doc.querySelector('#today-items');
  const weekly = doc.querySelector('#week-items');
  const later = doc.querySelector('#later-items');
  const completed = doc.querySelector('#completed-items');
  if (!today || !weekly || !later || !completed) return;
  today.replaceChildren();
  weekly.replaceChildren();
  later.replaceChildren();
  completed.replaceChildren();
  const inToday = visibleTodayTasks().sort(taskOrder);
  const weeklyTasks = activeTasks().filter((task) => task.status === 'open' && (task.scheduleWindow === 'this-week' || task.recurrence || (task.scheduledDate && task.scheduledDate !== todayKey())));
  const laterTasks = activeTasks().filter((task) => !task.scheduledDate && !task.scheduleWindow && !task.recurrence && task.status === 'open');
  const completedTasks = activeTasks().filter((task) => task.status === 'done' && !task.recurrence);
  for (const task of inToday) today.append(row(doc, task));
  for (const task of weeklyTasks) {
    weekly.append(row(doc, task));
    const history = recurringHistoryDisclosure(doc, task);
    if (history) weekly.append(history);
  }
  for (const task of laterTasks) later.append(row(doc, task));
  for (const task of completedTasks) completed.append(row(doc, task));
  if (!inToday.length) today.textContent = 'No tasks are scheduled for today.';
  if (!weeklyTasks.length) weekly.textContent = 'No flexible items for this week.';
  if (!laterTasks.length) later.textContent = 'Nothing in Later. Add a task whenever you are ready.';
  if (!completedTasks.length) completed.textContent = 'Completed tasks will appear here.';
}

function configureCapture(doc) {
  const textarea = doc.querySelector('#tempo-dump');
  const sortButton = [...doc.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Sort into queue');
  const voiceButton = [...doc.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Voice');
  const heading = [...doc.querySelectorAll('span')].find((item) => item.textContent.trim().startsWith('Sorted,'));
  const sortedBlock = heading?.parentElement;
  if (!textarea || !sortButton || !heading || !sortedBlock) return;

  const hasSavedDraft = typeof state.captureDraft === 'string';
  if (hasSavedDraft) textarea.value = state.captureDraft;
  else if (!state.demoData) textarea.value = '';
  let showingExample = !hasSavedDraft && state.demoData && isReferenceCaptureText(textarea.value);
  let listHost = sortedBlock.querySelector('.tempo-capture-list');

  const ensureListHost = () => {
    if (!listHost) {
      listHost = doc.createElement('div');
      listHost.className = 'tempo-capture-list';
      const note = [...sortedBlock.children].find((child) => child.textContent.trim().startsWith('Nothing is due today'));
      if (note) sortedBlock.insertBefore(listHost, note);
      else sortedBlock.append(listHost);
    }
    return listHost;
  };

  const renderSavedCaptures = () => {
    const host = ensureListHost();
    const note = [...sortedBlock.children].find((child) => child !== heading && child !== host && child.textContent.trim().startsWith('Nothing is due today'));
    [...sortedBlock.children].forEach((child) => { if (child !== heading && child !== host && child !== note) child.remove(); });
    renderCaptureRows(doc, host);
    if (!state.captures.length) {
      const empty = doc.createElement('p');
      empty.textContent = 'Captured thoughts appear here after you review and accept a split.';
      host.append(empty);
    }
  };

  if (state.captures.length || !state.demoData || hasSavedDraft) renderSavedCaptures();

  const saveDraft = (text) => {
    try {
      saveLocalState({ ...state, captureDraft: text });
      renderSavedCaptures();
      return true;
    } catch {
      showToast(doc, 'This draft could not be saved on this device. Keep the page open or copy your text before leaving.');
      return false;
    }
  };

  if (showingExample) {
    textarea.addEventListener('focus', () => {
      if (!showingExample) return;
      showingExample = false;
      textarea.value = '';
    }, { once: true });
  }
  textarea.addEventListener('input', () => {
    if (showingExample) return;
    saveDraft(textarea.value);
  });

  const finishVoiceCapture = async (blob) => {
    voiceBusy = true;
    if (voiceButton) { voiceButton.disabled = true; voiceButton.textContent = 'Transcribing…'; }
    showToast(doc, 'Transcribing on this device. Your audio stays in this browser.');
    try {
      const transcript = await voiceCapture.transcribe(blob);
      if (showingExample) textarea.value = '';
      showingExample = false;
      textarea.value = appendTranscript(textarea.value, transcript);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      textarea.focus();
      showToast(doc, 'Transcript added to your draft.');
    } catch (error) {
      showToast(doc, voiceErrorMessage(error));
    } finally {
      voiceBusy = false;
      if (voiceButton) { voiceButton.disabled = false; voiceButton.textContent = 'Voice'; voiceButton.setAttribute('aria-pressed', 'false'); }
    }
  };
  if (voiceButton) voiceButton.addEventListener('click', async () => {
    if (voiceBusy) return;
    voiceBusy = true;
    voiceButton.disabled = true;
    try {
      if (voiceCapture.recording) {
        voiceButton.textContent = 'Transcribing…';
        await finishVoiceCapture(await voiceCapture.stopRecording());
        return;
      }
      if (!voiceCapture.workerReady) {
        voiceButton.textContent = 'Loading…';
        showToast(doc, 'Loading the on-device speech model. This download is kept in browser cache.');
        await voiceCapture.load();
      }
      voiceButton.textContent = 'Starting microphone…';
      showToast(doc, 'Waiting for microphone permission.');
      await voiceCapture.startRecording({ onMaximumDuration: finishVoiceCapture });
      voiceBusy = false;
      voiceButton.disabled = false;
      voiceButton.textContent = 'Stop recording';
      voiceButton.setAttribute('aria-pressed', 'true');
      showToast(doc, 'Recording on this device. Select Stop recording when you are done.');
    } catch (error) {
      voiceBusy = false;
      voiceButton.disabled = false;
      voiceButton.textContent = 'Voice';
      voiceButton.setAttribute('aria-pressed', 'false');
      showToast(doc, voiceErrorMessage(error));
    }
  });
  sortButton.addEventListener('click', () => {
    if (showingExample) {
      showToast(doc, 'The text shown is an example. Your draft starts blank.');
      textarea.focus();
      return;
    }
    const proposal = createCaptureProposal(textarea.value);
    if (proposal.items.length === 0) {
      showToast(doc, 'Type one or more thoughts before reviewing them.');
      textarea.focus();
      return;
    }
    openCaptureReview(doc, proposal, (acceptedItems) => {
      const result = acceptCaptureProposal(state, proposal, acceptedItems);
      if (!result.capture) {
        showToast(doc, 'Choose at least one item to add. Your draft is still saved.');
        return false;
      }
      try {
        saveLocalState(result.state);
      } catch {
        showToast(doc, 'These tasks could not be saved. Your original draft is still available to review.');
        return false;
      }
      textarea.value = '';
      renderSavedCaptures();
      showToast(doc, `${result.tasks.length} reviewed ${result.tasks.length === 1 ? 'task' : 'tasks'} added to Later. Original capture saved.`);
      return true;
    });
  });
}

function openCaptureReview(doc, proposal, onAccept) {
  let dialog = doc.querySelector('#tempo-capture-review');
  if (!dialog) {
    dialog = doc.createElement('dialog');
    dialog.id = 'tempo-capture-review';
    dialog.className = 'tempo-dialog';
    dialog.setAttribute('aria-labelledby', 'tempo-capture-review-title');
    doc.body.append(dialog);
  }
  dialog.replaceChildren();

  const content = doc.createElement('div');
  content.className = 'tempo-capture-review';
  const title = doc.createElement('h2');
  title.id = 'tempo-capture-review-title';
  title.textContent = 'Review the split';
  const explanation = doc.createElement('p');
  explanation.textContent = 'Edit each title and choose which thoughts become tasks. New tasks stay in Later; no dates, estimates or categories are inferred.';
  const source = doc.createElement('p');
  source.className = 'source';
  const sourceLabel = doc.createElement('strong');
  sourceLabel.textContent = 'Original capture: ';
  source.append(sourceLabel, doc.createTextNode(proposal.sourceText));
  const list = doc.createElement('ol');

  proposal.items.forEach((candidate, index) => {
    const item = doc.createElement('li');
    item.className = 'tempo-capture-item';
    const titleLabel = doc.createElement('label');
    titleLabel.textContent = `Task title ${index + 1}`;
    const input = doc.createElement('input');
    input.type = 'text';
    input.maxLength = 160;
    input.value = candidate.title;
    input.setAttribute('aria-label', `Task title ${index + 1}`);
    input.dataset.candidateTitle = candidate.id;
    titleLabel.append(input);
    const includeLabel = doc.createElement('label');
    includeLabel.className = 'include';
    const include = doc.createElement('input');
    include.type = 'checkbox';
    include.checked = true;
    include.dataset.candidateInclude = candidate.id;
    const includeText = doc.createElement('span');
    includeText.textContent = 'Add this task to Later';
    includeLabel.append(include, includeText);
    item.append(titleLabel, includeLabel);
    list.append(item);
  });

  const actions = doc.createElement('div');
  actions.className = 'actions';
  const accept = doc.createElement('button');
  accept.type = 'button';
  accept.className = 'primary';
  accept.textContent = 'Accept selected';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  actions.append(accept, cancel);
  content.append(title, explanation, source, list, actions);
  dialog.append(content);

  accept.addEventListener('click', () => {
    const selected = [];
    for (const include of dialog.querySelectorAll('[data-candidate-include]')) {
      if (!include.checked) continue;
      const input = dialog.querySelector(`[data-candidate-title="${CSS.escape(include.dataset.candidateInclude)}"]`);
      const value = input.value.trim();
      if (!value) {
        input.setCustomValidity('Enter a task title or leave this item unchecked.');
        input.reportValidity();
        input.focus();
        return;
      }
      input.setCustomValidity('');
      selected.push({ id: include.dataset.candidateInclude, title: value });
    }
    if (onAccept(selected)) dialog.close();
  });
  cancel.addEventListener('click', () => dialog.close());
  dialog.showModal();
  dialog.querySelector('[data-candidate-title]')?.focus();
}

function renderCaptureGroup(doc, capture, host) {
  const group = doc.createElement('section');
  group.className = 'tempo-capture-group';
  const details = doc.createElement('details');
  const summary = doc.createElement('summary');
  summary.textContent = 'Original capture';
  const source = doc.createElement('p');
  source.textContent = capture.text;
  details.append(summary, source);
  group.append(details);
  state.tasks.filter((task) => task.parentCaptureId === capture.id && task.status !== 'removed')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .forEach((task) => group.append(row(doc, task)));
  host.append(group);
}

function renderCaptureRows(doc, host = doc.querySelector('.tempo-capture-list')) {
  if (!host) return;
  host.replaceChildren();
  state.captures.forEach((capture) => renderCaptureGroup(doc, capture, host));
  const heading = [...doc.querySelectorAll('span')].find((item) => item.textContent.trim().startsWith('Sorted,'));
  if (heading) heading.textContent = `Sorted, ${state.tasks.filter((task) => task.parentCaptureId && task.status !== 'removed').length} items`;
}

function syncDateLabel(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function renderSyncStatus(doc, status = syncClient.getStatus()) {
  if (!doc) return;
  const label = doc.querySelector('#sync-status-label');
  const detail = doc.querySelector('#sync-status-detail');
  if (!label || !detail) return;
  const pending = Number(status.pendingCount) || 0;
  const countText = `${pending} ${pending === 1 ? 'change' : 'changes'}`;
  let labelText = 'Not linked';
  let detailText = state.demoData
    ? 'Sample tasks stay on this device until you edit them. Open the shared planner link to sync.'
    : 'Your plan is saved in this browser. Open the shared planner link on this device to sync.';
  if (status.state === 'idle') {
    labelText = status.authenticated ? 'Connected' : 'Link needed';
    if (status.authenticated) detailText = 'This is one shared plan. Anyone with the shared link can view and edit it.';
  } else if (status.state === 'synced') {
    labelText = 'Up to date';
    detailText = status.lastSyncedAt ? `Last updated ${syncDateLabel(status.lastSyncedAt)}.` : 'Your latest changes reached the server.';
  } else if (status.state === 'pending') {
    labelText = 'Changes waiting';
    detailText = `${countText} are saved on this device and waiting to sync.`;
  } else if (status.state === 'syncing') {
    labelText = 'Syncing';
    detailText = pending ? `Sending ${countText} to the shared plan. Your local plan stays available.` : 'Checking the shared plan for changes.';
  } else if (status.state === 'offline') {
    labelText = 'Offline';
    detailText = pending ? `${countText} are saved here. Tempo will retry when you reconnect.` : 'Your plan is saved here. Tempo will check for updates when you reconnect.';
  } else if (status.state === 'retrying') {
    labelText = 'Retrying';
    detailText = pending ? `${countText} remain saved on this device while Tempo retries.` : 'Tempo could not reach the server. It will try again automatically.';
  } else if (status.state === 'unauthenticated') {
    labelText = 'Open shared link';
    detailText = pending ? `${countText} are safely queued on this device until you open the shared link.` : detailText;
  } else if (status.state === 'conflict') {
    labelText = 'Review sync';
  } else if (status.state === 'error') {
    labelText = 'Sync issue';
    if (status.error?.code === 'network_error') detailText = 'The server could not be reached. Your local changes remain saved and will retry.';
    else if (status.error?.code === 'storage_error') detailText = 'The planner is saved here, but Tempo could not persist the sync queue. Export a backup before closing.';
    else detailText = status.error?.message || 'Tempo could not sync this device. Your local plan remains saved.';
  }
  if (status.accountSwitchHydrating) {
    labelText = 'Loading shared plan';
    detailText = 'The shared plan is loading. Changes made during this moment stay on this device.';
  }

  const conflict = status.conflict;
  if (conflict?.reason === 'base_revision_expired') {
    detailText = 'Sync paused because the server no longer retains the version this change started from. Both copies are kept here for manual recovery.';
  } else if (conflict?.reason === 'account_mismatch') {
    detailText = 'Queued edits came from an earlier sync setup. Download them before continuing.';
  } else if (status.conflicts?.length) {
    detailText = 'Some fields changed on both devices. Tempo kept the server version and saved the other version in History.';
  }
  if (sharedPlanRecoveryError) {
    labelText = 'Shared plan paused';
    detailText = 'Tempo could not save a recovery copy. Your plan is still on this device. Export a backup, then reload before connecting.';
  }
  label.textContent = labelText;
  detail.textContent = detailText;

  const authForm = doc.querySelector('#sync-auth-form');
  const account = doc.querySelector('#sync-shared-panel');
  if (authForm) authForm.hidden = status.authenticated;
  if (account) account.hidden = !status.authenticated;
  const syncNow = doc.querySelector('#sync-now');
  if (syncNow) syncNow.disabled = !status.authenticated || conflict?.reason === 'base_revision_expired' || conflict?.reason === 'account_mismatch';
  const historyButton = doc.querySelector('#sync-history-load');
  if (historyButton) historyButton.disabled = !status.authenticated;

  const conflictPanel = doc.querySelector('#sync-conflict-panel');
  const conflictMessage = doc.querySelector('#sync-conflict-message');
  const hasExpiredBase = conflict?.reason === 'base_revision_expired';
  const hasAccountMismatch = conflict?.reason === 'account_mismatch';
  const hasMergedConflicts = Boolean(status.conflicts?.length);
  if (conflictPanel) conflictPanel.hidden = !hasExpiredBase && !hasAccountMismatch && !hasMergedConflicts;
  if (conflictMessage) {
    if (hasExpiredBase) conflictMessage.textContent = 'Choose which complete copy should become current. Tempo first archives the blocked local edits and the server copy on this device.';
    else if (hasAccountMismatch) conflictMessage.textContent = 'Queued edits belong to a different sync identity. Download them before continuing.';
    else if (hasMergedConflicts) conflictMessage.textContent = `${status.conflicts.length} overlapping change${status.conflicts.length === 1 ? '' : 's'} saved an alternate version in History.`;
  }
  for (const button of doc.querySelectorAll('[data-sync-resolve]')) button.hidden = !hasExpiredBase;
  const conflictDownload = doc.querySelector('#sync-download-conflict');
  if (conflictDownload) {
    conflictDownload.hidden = !hasExpiredBase && !hasAccountMismatch;
    conflictDownload.textContent = hasAccountMismatch ? 'Download queued edits' : 'Download both copies';
  }
  const recoveryDownload = doc.querySelector('#sync-download-recovery');
  if (recoveryDownload) recoveryDownload.hidden = syncClient.getRecoveryItems().length === 0;
  const previousPlanDownload = doc.querySelector('#sync-download-previous-plan');
  const hasPreviousPlan = previousLocalPlans().length > 0;
  if (previousPlanDownload) previousPlanDownload.hidden = !hasPreviousPlan;
  const accountRecoveryNote = doc.querySelector('#sync-previous-plan-note');
  if (accountRecoveryNote) accountRecoveryNote.hidden = !hasPreviousPlan;
  doc.querySelectorAll('.sync-history-actions button').forEach((button) => {
    button.disabled = !status.authenticated || pending > 0 || hasExpiredBase || hasAccountMismatch;
  });
}

function renderSyncConflict(doc, conflict = syncClient.getStatus().conflict) {
  if (!doc) return;
  const status = syncClient.getStatus();
  if (conflict && conflict !== status.conflict) status.conflict = conflict;
  renderSyncStatus(doc, status);
}

function applyRemoteState(remoteState, metadata = {}) {
  if (!remoteState || typeof remoteState !== 'object' || Array.isArray(remoteState)) return false;
  applyingCloudState = true;
  let applied = false;
  try {
    const defaults = createDemoState();
    const normalized = {
      ...remoteState,
      schema: 1,
      demoData: false,
      tasks: Array.isArray(remoteState.tasks) ? remoteState.tasks : [],
      captures: Array.isArray(remoteState.captures) ? remoteState.captures : [],
      focus: remoteState.focus ?? null,
      settings: { ...defaults.settings, ...(remoteState.settings ?? {}) },
    };
    state = saveState(storage, normalized);
    applied = true;
    syncScreen();
    reminderNotified.clear();
    transitionNotified.clear();
    scheduleDepartureReminder(frame.contentDocument);
    schedulePersistentTaskReminders(frame.contentDocument);
    scheduleTransitionWarning(frame.contentDocument);
  } catch (error) {
    const doc = frame.contentDocument;
    if (screenName === 'settings') showToast(doc, `Could not apply the cloud copy: ${error.message}`);
  } finally {
    applyingCloudState = false;
  }
  if (screenName === 'settings' || screenName === 'sync') renderSyncStatus(frame.contentDocument, syncClient.getStatus());
  if (!applied && sharedPlanBootstrapPending) sharedPlanRecoveryError = 'local_plan_apply_failed';
  return applied;
}

function previousLocalPlans() {
  try {
    const value = JSON.parse(storage.getItem(accountRecoveryKey) ?? '[]');
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

function archivePreviousLocalPlan() {
  const existing = previousLocalPlans();
  const recovery = [...existing, { archivedAt: new Date().toISOString(), state: syncableState(state) }];
  storage.setItem(accountRecoveryKey, JSON.stringify(recovery));
}

function downloadJson(doc, filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  doc.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderSyncHistory(doc, history) {
  const host = doc.querySelector('#sync-history-list');
  if (!host) return;
  host.replaceChildren();
  if (!history.length) {
    const empty = doc.createElement('p');
    empty.className = 'sync-history-empty';
    empty.textContent = 'No alternate versions are saved yet.';
    host.append(empty);
    return;
  }
  for (const entry of history) {
    const row = doc.createElement('article');
    row.className = 'sync-history-item';
    const heading = doc.createElement('strong');
    heading.textContent = entry.label || entry.path || 'Saved version';
    const meta = doc.createElement('span');
    meta.textContent = `${entry.path || 'Sync change'} · ${syncDateLabel(entry.createdAt) || 'Date unavailable'} · kept until ${syncDateLabel(entry.expiresAt) || '30 days after saving'}`;
    const actions = doc.createElement('div');
    actions.className = 'sync-history-actions';
    for (const [version, label] of [['losing', 'Restore other version'], ['winning', 'Restore server version']]) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await syncClient.restore(entry.id, version);
          showToast(doc, 'Version restored and synced.');
          await loadSyncHistory(doc);
        } catch (error) {
          showSyncActionError(doc, error);
        } finally {
          renderSyncStatus(doc, syncClient.getStatus());
        }
      });
      actions.append(button);
    }
    row.append(heading, meta, actions);
    host.append(row);
  }
  renderSyncStatus(doc, syncClient.getStatus());
}

async function loadSyncHistory(doc) {
  const button = doc.querySelector('#sync-history-load');
  const host = doc.querySelector('#sync-history-list');
  if (button) { button.disabled = true; button.textContent = 'Loading versions…'; }
  if (host) host.replaceChildren();
  try {
    const result = await syncClient.getHistory();
    renderSyncHistory(doc, result.history);
    if (button) button.textContent = result.hasMore ? 'Refresh saved versions' : 'Refresh history';
  } catch (error) {
    if (host) {
      const message = doc.createElement('p');
      message.className = 'sync-history-empty';
      message.textContent = `Could not load history: ${error.message}`;
      host.append(message);
    }
    if (button) button.textContent = 'Try history again';
  } finally {
    renderSyncStatus(doc, syncClient.getStatus());
  }
}

function showSyncActionError(doc, error) {
  const detail = doc.querySelector('#sync-status-detail');
  renderSyncStatus(doc, syncClient.getStatus());
  if (detail) detail.textContent = `${error?.message || 'The sync action did not finish.'} Your local data remains saved.`;
}

function configureReferenceSync(doc) {
  const syncButton = [...doc.querySelectorAll('button')].find(button => button.textContent.trim() === 'Sync now');
  if (syncButton) { syncButton.textContent = 'Sync settings'; syncButton.addEventListener('click', () => routeTo('sync')); }
  for (const span of doc.querySelectorAll('span')) {
    if (span.textContent.trim() === 'Synced just now') span.textContent = syncClient.getStatus().state === 'synced' ? 'Synced' : 'Sync not confirmed';
    if (span.textContent.trim() === 'Last synced 2 min ago') span.textContent = 'Status in Sync settings';
  }
}

function configureSettings(doc) {
  if (screenName === 'sync') { const back = doc.createElement('button'); back.type = 'button'; back.textContent = 'Back to settings'; back.addEventListener('click', () => routeTo('settings')); doc.body.firstElementChild?.prepend(back); }
  const switches = [...doc.querySelectorAll('div[style*="width: 52px"][style*="height: 30px"]')];
  const supported = new Map([
    ['Transition warnings', 'transitionWarnings'],
    ['Persistent reminders', 'persistentReminders'],
    ['Hyperfocus check-ins', 'hyperfocusCheckins'],
    ['Low-stimulation mode', 'lowStimulation'],
  ]);
  const descriptions = new Map([
    ['Transition warnings', '5 min before a scheduled task starts'],
    ['Persistent reminders', 'One repeat every 10 min · opted in · while open'],
    ['Hyperfocus check-ins', 'Every 60 min of active focus · while open'],
    ['Low-stimulation mode', 'Muted colours, no badges; alerts stay separate'],
  ]);
  for (const toggle of switches) {
    const label = toggle.parentElement?.querySelector('span')?.textContent.trim() ?? '';
    const key = supported.get(label);
    const detail = toggle.parentElement?.querySelectorAll('span')[1];
    if (detail && descriptions.has(label)) detail.textContent = descriptions.get(label);
    const wrapper = doc.createElement('label');
    wrapper.className = 'tempo-switch';
    const input = doc.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.setAttribute('aria-label', label);
    input.checked = key ? Boolean(state.settings[key]) : toggle.firstElementChild?.style.right !== '';
    input.disabled = !key;
    input.style.cssText = `appearance:none;position:absolute;inset:0;width:52px;height:30px;margin:0;opacity:0;cursor:${key?'pointer':'not-allowed'};z-index:1`;
    wrapper.style.cssText = `position:relative;display:block;flex:0 0 52px;width:52px;height:30px;border-radius:15px;background:${input.checked?'#2B5FC4':'#C2CAD6'};opacity:${key?1:.62}`;
    wrapper.append(input);
    input.dataset.setting = key || '';
    if (!key) input.title = `${label} is a preview control; this behavior is not implemented yet.`;
    const thumb = doc.createElement('span');
    thumb.style.cssText = `position:absolute;top:4px;${input.checked?'right':'left'}:4px;width:22px;height:22px;border-radius:11px;background:#FFFFFF;pointer-events:none`;
    wrapper.append(thumb);
    input.addEventListener('change', () => {
      if (!key) return;
      saveLocalState({ ...state, settings: { ...state.settings, [key]: input.checked } });
      wrapper.style.background = input.checked ? '#2B5FC4' : '#C2CAD6';
      thumb.style.left = input.checked ? 'auto' : '4px';
      thumb.style.right = input.checked ? '4px' : 'auto';
      applyLowStimulation(doc);
      const messages = {
        persistentReminders: input.checked
          ? 'Repeat reminders are on for tasks you opt in to. Tempo must stay open.'
          : 'Repeat reminders are off.',
        hyperfocusCheckins: input.checked
          ? 'A gentle check-in follows 60 minutes of active focus while Tempo is open.'
          : 'Hyperfocus check-ins are off.',
        lowStimulation: input.checked
          ? 'Colours are muted and status badges are hidden. Alerts still appear one at a time.'
          : 'Low-stimulation mode is off.',
      };
      const message = messages[key] ?? `${label} ${input.checked ? 'on' : 'off'}.`;
      showToast(doc, `${message} Saved on this device.`);
      scheduleTransitionWarning(doc);
    });
    toggle.replaceWith(wrapper);
  }
  const exportButton = doc.querySelector('#backup-export');
  exportButton?.addEventListener('click', () => exportBackup(doc));
  if (exportButton?.parentElement) {
    const importLabel=doc.createElement('label'); importLabel.textContent='Import backup'; importLabel.style.cssText='display:flex;align-items:center;justify-content:center;min-height:46px;margin-top:8px;border:1px solid #1B2430;border-radius:10px;background:transparent;color:#1B2430;font:inherit;font-size:15px;font-weight:700;cursor:pointer';
    const file=doc.createElement('input'); file.type='file'; file.accept='application/json,.json'; file.hidden=true; file.setAttribute('aria-label','Choose a Tempo JSON backup'); importLabel.append(file); exportButton.parentElement.insertBefore(importLabel,exportButton.nextSibling);
    file.addEventListener('change', async () => {
      const selected=file.files?.[0]; if (!selected) return;
      try {
        const imported=parseBackup(await selected.text());
        if (!imported) throw new Error('Invalid Tempo backup');
        if (!window.confirm('Replace the tasks and captures saved in this browser with this backup?')) { file.value=''; return; }
        saveLocalState(imported); reminderNotified.clear(); transitionNotified.clear();
        routeTo('today'); showToast(frame.contentDocument,'Backup restored on this device.');
      } catch { showToast(doc,'That file is not a valid Tempo backup. Your saved data was not changed.'); }
      finally { file.value=''; }
    });
  }
  doc.querySelector('#sync-now')?.addEventListener('click', async () => {
    try { await syncClient.syncNow(); }
    catch (error) { showSyncActionError(doc, error); }
    renderSyncStatus(doc, syncClient.getStatus());
  });
  doc.querySelector('#sync-history-load')?.addEventListener('click', () => loadSyncHistory(doc));
  doc.querySelectorAll('[data-sync-resolve]').forEach((button) => button.addEventListener('click', async () => {
    const conflict = syncClient.getStatus().conflict;
    const chosen = button.dataset.syncResolve === 'local' ? conflict?.localState : conflict?.remote?.state;
    if (!chosen) { showSyncActionError(doc, new Error('The selected copy is unavailable. Download the conflict details before continuing.')); return; }
    button.disabled = true;
    try {
      syncClient.resolveExpiredBase(chosen);
      await syncClient.syncNow();
      showToast(doc, button.dataset.syncResolve === 'local' ? 'This device copy is now current.' : 'The server copy is now current. Your blocked edits remain in local recovery.');
    } catch (error) {
      showSyncActionError(doc, error);
    } finally {
      renderSyncStatus(doc, syncClient.getStatus());
    }
  }));
  doc.querySelector('#sync-download-conflict')?.addEventListener('click', () => {
    const conflict = syncClient.getStatus().conflict;
    if (conflict?.reason === 'base_revision_expired') {
      downloadJson(doc, `tempo-sync-conflict-${todayKey()}.json`, { format: 'tempo-sync-conflict', conflict });
    } else if (conflict?.reason === 'account_mismatch') {
      downloadJson(doc, `tempo-sync-queued-${todayKey()}.json`, { format: 'tempo-sync-queued', userId: conflict?.queuedUserId ?? null, operations: syncClient.getPendingOperations() });
    }
  });
  doc.querySelector('#sync-download-recovery')?.addEventListener('click', () => {
    const recovery = syncClient.getRecoveryItems().at(-1);
    const localState = [...(recovery?.queuedOperations ?? [])].reverse().find((operation) => operation.type === 'state')?.state;
    downloadJson(doc, `tempo-recovery-${todayKey()}.json`, localState ?? { format: 'tempo-sync-recovery', recovery: syncClient.getRecoveryItems() });
  });
  doc.querySelector('#sync-download-previous-plan')?.addEventListener('click', () => {
    const previousCopy = previousLocalPlans().at(-1)?.state;
    if (previousCopy) downloadJson(doc, `tempo-backup-${todayKey()}.json`, previousCopy);
  });
  renderSyncStatus(doc, syncClient.getStatus());
  if (!state.settings.transitionWarnings) return;
}

function exportBackup(doc) {
  downloadJson(doc, `tempo-backup-${todayKey()}.json`, state);
  showToast(doc, 'Backup downloaded. Import it on another device to transfer local data.');
}

function configureFocus(doc) {
  const back = byText(doc, 'Back');
  setInteractive(back, 'Return to Today', () => routeTo('today'));
  const active = state.focus;
  if (active?.status === 'running' && (focusRunTaskId !== active.taskId || focusRunStartedAt === null)) {
    focusRunTaskId = active.taskId;
    focusRunStartedAt = Date.now();
  }
  const timer = doc.querySelector('svg text[y="128"]');
  if (timer) { timer.textContent = active?.status === 'done' ? 'Done' : formatClock(active?.status === 'paused' ? active.remainingMs : 25 * 60_000); timer.setAttribute('aria-label', active?.status === 'done' ? 'Focus session done' : `${timer.textContent} remaining`); }
  updateFocusRing(doc, active?.status === 'running' ? active.dueAt - Date.now() : active?.status === 'paused' ? active.remainingMs : 25 * 60_000);
  const focusedTask = state.tasks.find((task) => task.id === (active?.taskId || state.currentTaskId || 'budget'));
  const focusTitle = [...doc.querySelectorAll('span')].find((item) => item.textContent.trim() === 'Working on');
  if (focusTitle?.parentElement && focusedTask) {
    const title = [...focusTitle.parentElement.querySelectorAll('span')].find((item) => item.textContent.trim() === 'Draft the budget summary');
    if (title) title.textContent = focusedTask.title;
  }
  const control = [...doc.querySelectorAll('button')].find((button) => ['Pause', 'Resume', 'Start'].includes(button.textContent.trim()));
  if (control) {
    control.textContent = active?.status === 'running' ? 'Pause' : active?.status === 'paused' ? 'Resume' : 'Start';
    control.addEventListener('click', () => {
      if (!state.focus || state.focus.status === 'done') {
        startFocus(doc);
      } else if (state.focus.status === 'running') {
        const now = Date.now();
        const activeTimeMs = focusActiveTime(state.focus, now);
        focusRunStartedAt = null;
        focusRunTaskId = null;
        state = { ...state, focus: { ...state.focus, status: 'paused', remainingMs: Math.max(0, state.focus.dueAt - now), dueAt: null, activeTimeMs } };
        persist();
        routeTo('focus');
      } else {
        const now = Date.now();
        focusRunStartedAt = now;
        focusRunTaskId = state.focus.taskId;
        state = { ...state, focus: { ...state.focus, status: 'running', dueAt: now + state.focus.remainingMs } };
        persist();
        routeTo('focus');
      }
    });
  }
  const done = [...doc.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Done');
  if (done && (!active || (active.status === 'done' && active.blockClosed === true))) done.disabled = true;
  done?.addEventListener('click', () => {
    const completedAt = new Date();
    const focusedTaskId = state.focus?.taskId;
    const focusedTask = state.tasks.find((task) => task.id === focusedTaskId);
    let taskCompletionMessage = '';
    let tasks = state.tasks;
    if (focusedTask && focusedTask.status !== 'removed') {
      if (focusedTask.recurrence) {
        try {
          const current = currentWeeklyTaskState(focusedTask, completedAt);
          if (current.valid && !current.beforeStart && !current.completed) {
            const result = recordWeeklyCompletion(focusedTask.recurrence, weeklyCompletionList(focusedTask), completedAt);
            if (result.added) {
              tasks = state.tasks.map((task) => task.id === focusedTask.id
                ? { ...task, status: 'open', recurrenceCompletions: weeklyCompletionMap(result.completions) }
                : task);
              taskCompletionMessage = ' Task marked complete for this week.';
            } else if (result.reason === 'already-completed') {
              taskCompletionMessage = ' This task was already complete for this week.';
            }
          } else if (current.completed) {
            taskCompletionMessage = ' This task was already complete for this week.';
          } else {
            taskCompletionMessage = current.beforeStart
              ? ' This weekly task has not started yet, so it was not marked complete.'
              : ' This task could not be marked complete. Review its weekly settings.';
          }
        } catch {
          taskCompletionMessage = ' The task could not be marked complete because its weekly history needs review.';
        }
      } else if (focusedTask.status !== 'done') {
        tasks = state.tasks.map((task) => task.id === focusedTask.id
          ? { ...task, status: 'done', completedAt: completedAt.toISOString() }
          : task);
        taskCompletionMessage = ' Task completed.';
      } else {
        taskCompletionMessage = ' This task was already complete.';
      }
    }
    const activeTimeMs = state.focus ? focusActiveTime(state.focus) : 0;
    focusRunStartedAt = null;
    focusRunTaskId = null;
    state = {
      ...state,
      tasks,
      focus: state.focus
        ? { ...state.focus, status: 'done', remainingMs: 0, dueAt: null, activeTimeMs, blockClosed: true, completedAt: completedAt.toISOString() }
        : state.focus,
    };
    persist();
    const sessionMessage = state.focus ? 'Focus session complete.' : 'Focus ended.';
    const resultMessage = taskCompletionMessage || ' No associated task was available to complete.';
    showToast(doc, `${sessionMessage}${resultMessage}`);
    if (timer) {
      timer.textContent = 'Done';
      timer.setAttribute('aria-label', 'Focus session done');
    }
    updateFocusRing(doc, 0);
    if (control) control.textContent = 'Start';
    if (done) done.disabled = true;
  });
  for (const button of doc.querySelectorAll('button')) {
    if (['Stretch 2 min', 'Tea', 'One song'].includes(button.textContent.trim())) button.addEventListener('click', () => showToast(doc, `Break idea: ${button.textContent.trim()}. No break timer has been started.`));
  }
  const currentTask = state.tasks.find((task) => task.id === (state.currentTaskId || 'budget'));
  const stuck = [...doc.querySelectorAll('span')].find((item) => item.textContent.trim() === 'Open the budget file and read the first row');
  if (stuck) {
    stuck.setAttribute('role', 'button'); stuck.tabIndex=0; stuck.setAttribute('aria-label','Edit the smallest next step');
    stuck.addEventListener('click', () => currentTask && openTaskDialog(doc, currentTask));
  }
  if (active?.status === 'running') {
    tickHandle = window.setInterval(() => updateFocusClock(doc), 1000);
    updateFocusClock(doc);
  }
}

function focusActiveTime(focus, now = Date.now()) {
  const completedMs = Math.max(0, Number(focus?.activeTimeMs) || 0);
  if (focus?.status !== 'running' || focusRunTaskId !== focus.taskId || !Number.isFinite(focusRunStartedAt)) return completedMs;
  const dueAt = Number(focus.dueAt);
  const activeUntil = Number.isFinite(dueAt) ? Math.min(now, dueAt) : now;
  return completedMs + Math.max(0, activeUntil - focusRunStartedAt);
}

function startFocus(doc) {
  const task = activeTasks().find(item => item.id === state.currentTaskId && item.status === 'open') || visibleTodayTasks()[0];
  if (!task) { showToast(doc, 'Choose an open task before starting focus.'); return; }
  const previousFocus = state.focus;
  const continueBlock = previousFocus?.taskId === task.id && previousFocus.status === 'done' && previousFocus.blockClosed !== true;
  const now = Date.now();
  focusRunStartedAt = now;
  focusRunTaskId = task.id;
  state = {
    ...state,
    currentTaskId: task.id,
    focus: {
      taskId: task.id,
      status: 'running',
      startedAt: continueBlock ? previousFocus.startedAt : new Date(now).toISOString(),
      dueAt: now + 25 * 60_000,
      remainingMs: 25 * 60_000,
      activeTimeMs: continueBlock ? Math.max(0, Number(previousFocus.activeTimeMs) || 0) : 0,
      nextCheckInMs: continueBlock ? Math.max(HYPERFOCUS_CHECKIN_INTERVAL_MS, Number(previousFocus.nextCheckInMs) || HYPERFOCUS_CHECKIN_INTERVAL_MS) : HYPERFOCUS_CHECKIN_INTERVAL_MS,
      blockClosed: false,
    },
  };
  persist();
  routeTo('focus');
}

function updateFocusClock(doc) {
  if (screenName !== 'focus' || !state.focus || state.focus.status !== 'running') return;
  const left = Math.max(0, state.focus.dueAt - Date.now());
  const minutes = Math.floor(left / 60_000);
  const seconds = Math.floor((left % 60_000) / 1000);
  const text = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} of 25 min`;
  const timer = doc.querySelector('svg text[y="128"]');
  if (timer) { timer.textContent = text.slice(0, 5); timer.setAttribute('aria-label', `${text.slice(0,5)} remaining`); }
  updateFocusRing(doc, left);
  if (state.settings?.hyperfocusCheckins) {
    const activeMs = focusActiveTime(state.focus);
    let nextCheckInMs = Math.max(HYPERFOCUS_CHECKIN_INTERVAL_MS, Number(state.focus.nextCheckInMs) || HYPERFOCUS_CHECKIN_INTERVAL_MS);
    if (activeMs >= nextCheckInMs) {
      while (nextCheckInMs <= activeMs) nextCheckInMs += HYPERFOCUS_CHECKIN_INTERVAL_MS;
      state = { ...state, focus: { ...state.focus, nextCheckInMs } };
      saveLocalState(state);
      showToast(doc, 'You have been focusing for about an hour. Would a pause, drink, or stretch help? You can continue if you like.');
    }
  }
  if (left <= 0) {
    window.clearInterval(tickHandle);
    const activeTimeMs = focusActiveTime(state.focus);
    focusRunStartedAt = null;
    focusRunTaskId = null;
    state = { ...state, focus: { ...state.focus, status: 'done', remainingMs: 0, dueAt: null, activeTimeMs, blockClosed: false, completedAt: new Date().toISOString() } };
    persist();
    showToast(doc, 'Focus time is complete. Take a break or return to your plan.');
  }
}

function formatClock(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateFocusRing(doc, remainingMs) {
  const ring = doc.querySelector('svg circle[stroke="#7FB2FF"]');
  if (!ring) return;
  const total = 704;
  const progress = Math.max(0, Math.min(1, 1 - remainingMs / (25 * 60_000)));
  ring.setAttribute('stroke-dashoffset', String(total * (1 - progress)));
}

function syncScreen() {
  if (frame.contentDocument) {
    const doc = frame.contentDocument;
    if (screenName === 'today' || screenName === 'week') renderCurrentPlan(doc, window.matchMedia('(min-width: 768px)').matches);
    if (screenName === 'plan') renderMobilePlanLists(doc);
    if (screenName === 'brain-dump') renderCaptureRows(doc);
  }
  scheduleDepartureReminder(frame.contentDocument);
  schedulePersistentTaskReminders(frame.contentDocument);
  scheduleTransitionWarning(frame.contentDocument);
}

function scheduleDepartureReminder(doc) {
  window.clearTimeout(reminderHandle);
  reminderHandle = null;
  const candidates = activeTasks().filter((task) => task.status === 'open' && task.leaveReminderEnabled && task.departureTime && !task.reminderDismissed && !task.reminderSentAt && !reminderNotified.has(task.id));
  candidates.sort((a, b) => reminderTime(a) - reminderTime(b));
  const next = candidates.find((task) => Number.isFinite(reminderTime(task)));
  if (!next) return;
  const when = reminderTime(next);
  const wait = when - Date.now();
  if (wait <= 0) {
    if (wait > -5 * 60_000) deliverDepartureReminder(next, doc);
    else markReminderDismissed(next.id);
    return;
  }
  if (wait > 2_147_000_000) reminderHandle = window.setTimeout(() => scheduleDepartureReminder(frame.contentDocument), 2_147_000_000);
  else reminderHandle = window.setTimeout(() => deliverDepartureReminder(next, frame.contentDocument), wait);
}

function reminderTime(task) {
  const departure = new Date(task.departureTime).getTime();
  if (!Number.isFinite(departure)) return Number.NaN;
  return task.snoozeUntil ? Math.min(new Date(task.snoozeUntil).getTime(), departure) : reminderAt(task.departureTime, task.leaveLeadMinutes ?? 2);
}

function deliverDepartureReminder(task, doc) {
  if (reminderNotified.has(task.id)) return;
  reminderNotified.add(task.id);
  state = { ...state, tasks: state.tasks.map((item) => item.id === task.id ? { ...item, reminderSentAt: new Date().toISOString(), snoozeUntil: null } : item) };
  saveLocalState(state);
  const message = `Time to get ready to leave for ${task.title}.`;
  if (task.leaveDelivery === 'system' && 'Notification' in window && Notification.permission === 'granted') {
    new Notification(message, { body: 'A gentle reminder from Tempo.', tag: `tempo-leave-${task.id}`, silent: true });
  }
  if (doc?.body) {
    const toast = doc.createElement('div');
    toast.className = 'tempo-toast';
    toast.setAttribute('role', 'alert');
    const text = doc.createElement('span'); text.textContent = message;
    const snooze = doc.createElement('button'); snooze.type = 'button'; snooze.textContent = 'Snooze 5 min';
    const dismiss = doc.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss';
    for (const button of [snooze, dismiss]) button.style.cssText = 'min-height:40px;margin:8px 8px 0 0;padding:4px 10px;border:1px solid #FFFFFF;border-radius:8px;background:transparent;color:#FFFFFF;font:inherit';
    snooze.addEventListener('click', () => {
      const departure = new Date(task.departureTime).getTime();
      reminderNotified.delete(task.id);
      state = { ...state, tasks: state.tasks.map((item) => item.id === task.id ? { ...item, reminderSentAt: null, reminderDismissed: false, snoozeUntil: new Date(Math.min(Date.now() + 5 * 60_000, departure)).toISOString() } : item) };
      saveLocalState(state); toast.remove(); scheduleDepartureReminder(doc);
    });
    dismiss.addEventListener('click', () => { markReminderDismissed(task.id); toast.remove(); });
    toast.append(text, doc.createElement('br'), snooze, dismiss);
    doc.body.append(toast);
  }
}

function markReminderDismissed(taskId) {
  state = { ...state, tasks: state.tasks.map((task) => task.id === taskId ? { ...task, reminderDismissed: true } : task) };
  saveLocalState(state);
}

function persistentReminderAt(task) {
  const deadline = new Date(task.deadline).getTime();
  if (!Number.isFinite(deadline)) return Number.NaN;
  const next = task.persistentReminderNextAt ? new Date(task.persistentReminderNextAt).getTime() : Number.NaN;
  return Number.isFinite(next) ? Math.max(deadline, next) : deadline;
}

function schedulePersistentTaskReminders(doc) {
  window.clearTimeout(persistentReminderHandle);
  persistentReminderHandle = null;
  if (!state.settings?.persistentReminders || state.demoData) return;

  const candidates = activeTasks()
    .filter((task) => task.status === 'open' && task.persistentReminderEnabled)
    .map((task) => ({ task, at: persistentReminderAt(task) }))
    .filter((item) => Number.isFinite(item.at))
    .sort((a, b) => a.at - b.at);
  const next = candidates[0];
  if (!next) return;

  const when = Math.max(next.at, persistentReminderQuietUntil);
  const wait = Math.max(0, when - Date.now());
  const delay = Math.min(wait, 2_147_000_000);
  persistentReminderHandle = window.setTimeout(() => {
    if (delay < wait) schedulePersistentTaskReminders(frame.contentDocument);
    else deliverPersistentTaskReminder(next.task, frame.contentDocument || doc);
  }, delay);
}

function deliverPersistentTaskReminder(task, doc) {
  const current = state.tasks.find((item) => item.id === task.id);
  if (!state.settings?.persistentReminders || current?.status !== 'open' || !current.persistentReminderEnabled) {
    schedulePersistentTaskReminders(doc);
    return;
  }
  const now = Date.now();
  if (persistentReminderAt(current) > now || persistentReminderQuietUntil > now) {
    schedulePersistentTaskReminders(doc);
    return;
  }

  const nextAt = new Date(now + PERSISTENT_REMINDER_INTERVAL_MS).toISOString();
  persistentReminderQuietUntil = now + PERSISTENT_REMINDER_INTERVAL_MS;
  state = {
    ...state,
    tasks: state.tasks.map((item) => item.id === task.id ? { ...item, persistentReminderNextAt: nextAt } : item),
  };
  saveLocalState(state);

  if (!doc?.body) return;
  doc.querySelector('.tempo-persistent-reminder')?.remove();
  const toast = doc.createElement('div');
  toast.className = 'tempo-toast tempo-persistent-reminder';
  toast.setAttribute('role', 'group');
  toast.setAttribute('aria-label', `Reminder for ${current.title}`);
  const message = doc.createElement('p');
  message.setAttribute('aria-live', 'polite');
  message.textContent = `A gentle reminder: “${current.title}” is past its due time.`;
  const actions = doc.createElement('div');
  actions.className = 'actions';

  const updateReminder = (changes, { quietUntil = persistentReminderQuietUntil, toastMessage = '' } = {}) => {
    persistentReminderQuietUntil = quietUntil;
    state = {
      ...state,
      tasks: state.tasks.map((item) => item.id === task.id ? { ...item, ...changes } : item),
    };
    saveLocalState(state);
    toast.remove();
    if (toastMessage) showToast(doc, toastMessage);
  };

  const snooze = doc.createElement('button');
  snooze.type = 'button';
  snooze.textContent = 'Snooze 5 min';
  snooze.addEventListener('click', () => {
    const snoozeUntil = new Date(Date.now() + 5 * 60_000);
    updateReminder(
      { persistentReminderNextAt: snoozeUntil.toISOString() },
      { quietUntil: Math.min(persistentReminderQuietUntil, snoozeUntil.getTime()) },
    );
  });

  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Dismiss for 10 min';
  dismiss.addEventListener('click', () => updateReminder({ persistentReminderNextAt: new Date(Date.now() + PERSISTENT_REMINDER_INTERVAL_MS).toISOString() }));

  const disable = doc.createElement('button');
  disable.type = 'button';
  disable.textContent = 'Turn off repeats';
  disable.addEventListener('click', () => updateReminder(
    { persistentReminderEnabled: false, persistentReminderNextAt: null },
    { toastMessage: 'Repeated reminders are off for this task.' },
  ));

  actions.append(snooze, dismiss, disable);
  toast.append(message, actions);
  doc.body.append(toast);
}

function scheduleTransitionWarning(doc) {
  window.clearTimeout(transitionHandle);
  transitionHandle = null;
  if (!state.settings.transitionWarnings) return;
  const next = visibleTodayTasks().filter((task) => task.startTime && !transitionNotified.has(task.id))
    .map((task) => ({ task, at: new Date(`${task.scheduledDate}T${task.startTime}`).getTime() - 5 * 60_000 }))
    .filter((item) => Number.isFinite(item.at)).sort((a, b) => a.at - b.at)[0];
  if (!next) return;
  const wait = next.at - Date.now();
  if (wait <= 0) {
    if (wait > -5 * 60_000 && doc?.body) {
      transitionNotified.add(next.task.id);
      showToast(doc, `Your next task, ${next.task.title}, starts in about 5 minutes.`);
    }
    return;
  }
  transitionHandle = window.setTimeout(() => scheduleTransitionWarning(frame.contentDocument), Math.min(wait, 2_147_000_000));
}

window.addEventListener('hashchange', routeFromLocation);
window.addEventListener('resize', () => renderScreen());
window.addEventListener('focus', () => {
  if (state.focus?.status === 'running' && state.focus.dueAt <= Date.now()) updateFocusClock(frame.contentDocument);
  scheduleDepartureReminder(frame.contentDocument);
  schedulePersistentTaskReminders(frame.contentDocument);
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (state.focus?.status === 'running' && state.focus.dueAt <= Date.now()) updateFocusClock(frame.contentDocument);
    scheduleDepartureReminder(frame.contentDocument);
    schedulePersistentTaskReminders(frame.contentDocument);
  }
});
window.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === ',') {
    event.preventDefault();
    routeTo('settings');
  }
});
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/src/sw.js').catch(() => {});
if (window.location.hash && window.location.hash.length > 1) routeFromLocation();
else {
  screenName = 'today';
  renderScreen();
}
if (sharedPlanRecoveryReady) syncClient.start();
else renderSyncStatus(frame.contentDocument, syncClient.getStatus());
