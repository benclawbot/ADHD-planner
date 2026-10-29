export const STORAGE_KEY = 'tempo-planner-state-v1';
export const REFERENCE_CAPTURE_TEXT = 'call the bank re card, budget, gym legs, reply to Marc, buy birthday card, dentist sometime';

export function makeId(prefix = 'item') {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`}`;
}

export function todayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function reminderAt(departureTime, leadMinutes = 2) {
  if (!departureTime) return null;
  const departure = new Date(departureTime).getTime();
  if (!Number.isFinite(departure)) return null;
  const lead = Math.max(1, Math.min(180, Number(leadMinutes) || 2));
  return departure - lead * 60_000;
}

export function createDemoState() {
  const date = '2026-10-29';
  return {
    schema: 1,
    demoData: true,
    tasks: [
      { id: 'budget', title: 'Draft the budget summary', durationMinutes: 40, category: 'Desk', deadline: `${date}T17:00`, scheduledDate: date, startTime: '14:05', status: 'open', nextStep: 'Open the budget file and read the first row', notes: '' },
      { id: 'reply', title: 'Reply to Marc about invoices', durationMinutes: 15, category: 'Desk', deadline: '', scheduledDate: date, startTime: '15:00', status: 'open', notes: '' },
      { id: 'team-call', title: 'Team call', durationMinutes: 30, category: 'Meeting', deadline: '', scheduledDate: date, startTime: '16:00', status: 'open', notes: '' },
      { id: 'gym', title: 'Gym: legs', durationMinutes: 60, category: 'Personal', deadline: '', scheduledDate: date, startTime: '18:00', status: 'open', notes: '' },
      { id: 'dentist', title: 'Dentist', durationMinutes: 0, category: 'Personal', deadline: '', scheduledDate: '', startTime: '', status: 'open', notes: '' },
    ],
    captures: [],
    focus: null,
    settings: {
      transitionWarnings: true,
      persistentReminders: true,
      flexibleRecurringTasks: true,
      noGuiltRescheduling: true,
      hyperfocusCheckins: true,
      lowStimulation: false,
      bodyDouble: false,
    },
  };
}

export function parseCapture(text) {
  return text
    .split(/[\n,;]+/)
    .map((title) => title.trim())
    .filter(Boolean);
}

export function isReferenceCaptureText(text) {
  return String(text ?? '').trim() === REFERENCE_CAPTURE_TEXT;
}

export function createCaptureProposal(text) {
  const sourceText = String(text ?? '');
  return {
    sourceText,
    items: parseCapture(sourceText).map((title, index) => ({ id: `candidate-${index + 1}`, title })),
  };
}

export function acceptCaptureProposal(state, proposal, acceptedItems, now = new Date().toISOString()) {
  const sourceText = String(proposal?.sourceText ?? '');
  if (!sourceText.trim() || !Array.isArray(proposal?.items) || !Array.isArray(acceptedItems)) {
    return { state, capture: null, tasks: [] };
  }

  const acceptedById = new Map();
  for (const item of acceptedItems) {
    if (typeof item?.id !== 'string' || typeof item?.title !== 'string') continue;
    if (proposal.items.some((candidate) => candidate.id === item.id)) {
      const title = item.title.trim();
      if (title) acceptedById.set(item.id, title);
    }
  }
  const accepted = proposal.items.filter((item) => acceptedById.has(item.id));
  if (accepted.length === 0) return { state, capture: null, tasks: [] };

  const capture = { id: makeId('capture'), text: sourceText, createdAt: now };
  const tasks = accepted.map((item, index) => ({
    id: makeId('task'),
    title: acceptedById.get(item.id),
    durationMinutes: 0,
    category: '',
    deadline: '',
    scheduledDate: '',
    startTime: '',
    status: 'open',
    notes: '',
    parentCaptureId: capture.id,
    order: index,
  }));

  return {
    capture,
    tasks,
    state: {
      ...state,
      captureDraft: '',
      captures: [...(state.captures ?? []), capture],
      tasks: [...(state.tasks ?? []), ...tasks],
    },
  };
}

export function addCapture(state, text, now = new Date().toISOString()) {
  const proposal = createCaptureProposal(text);
  return acceptCaptureProposal(state, proposal, proposal.items, now);
}

export function reorderCaptureTask(state, captureId, taskId, direction) {
  const children = state.tasks
    .filter((task) => task.parentCaptureId === captureId && task.status !== 'removed')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const index = children.findIndex((task) => task.id === taskId);
  const nextIndex = index + direction;
  if (index < 0 || nextIndex < 0 || nextIndex >= children.length) return state;
  [children[index], children[nextIndex]] = [children[nextIndex], children[index]];
  const orderById = new Map(children.map((task, i) => [task.id, i]));
  return {
    ...state,
    tasks: state.tasks.map((task) => orderById.has(task.id) ? { ...task, order: orderById.get(task.id) } : task),
  };
}

export function removeTask(state, taskId) {
  return {
    ...state,
    tasks: state.tasks.map((task) => task.id === taskId ? { ...task, status: 'removed' } : task),
  };
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]));
}

function withoutUntouchedDemoTasks(state) {
  const demoTasks = new Map(createDemoState().tasks.map((task) => [task.id, task]));
  return state.tasks.filter((task) => !demoTasks.has(task.id) || !sameValue(task, demoTasks.get(task.id)));
}

export function saveState(storage, state) {
  const tasks = state.demoData ? withoutUntouchedDemoTasks(state) : state.tasks;
  const saved = { ...state, tasks, demoData: false, updatedAt: new Date().toISOString() };
  storage.setItem(STORAGE_KEY, JSON.stringify(saved));
  return saved;
}

export function loadState(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return createDemoState();
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== 1 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.captures)) return createDemoState();
    return parsed;
  } catch {
    return createDemoState();
  }
}

export function parseBackup(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (parsed?.schema !== 1 || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.captures)) return null;
  if (!parsed.tasks.every((task) => task && typeof task.id === 'string' && typeof task.title === 'string' && typeof task.status === 'string')) return null;
  if (!parsed.captures.every((capture) => capture && typeof capture.id === 'string' && typeof capture.text === 'string')) return null;
  return {
    ...parsed,
    demoData: false,
    settings: { ...createDemoState().settings, ...(parsed.settings ?? {}) },
    focus: parsed.focus && ['running', 'paused', 'done'].includes(parsed.focus.status) ? parsed.focus : null,
  };
}
