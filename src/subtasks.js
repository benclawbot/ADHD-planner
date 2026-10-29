/**
 * Pure model helpers for manually proposed subtasks.
 *
 * A proposal is an in-memory draft. Its titles come only from the caller; this
 * module does not generate or enrich task content. Callers provide persistent
 * task IDs when accepting a proposal so the transformations remain pure.
 */

function normalizeOrder(items) {
  return items.map((item, order) => ({ ...item, order }));
}

function childrenOf(state, parentTaskId, { includeRemoved = false } = {}) {
  return state.tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.parentTaskId === parentTaskId
      && (includeRemoved || task.status !== 'removed'))
    .sort((a, b) => (a.task.order ?? a.index) - (b.task.order ?? b.index));
}

function updateChildOrders(state, parentTaskId, orderedChildren) {
  const orderById = new Map(orderedChildren.map((task, order) => [task.id, order]));
  return {
    ...state,
    tasks: state.tasks.map((task) => orderById.has(task.id)
      ? { ...task, order: orderById.get(task.id) }
      : task),
  };
}

/**
 * Start a transient proposal from an explicit list of user-supplied titles.
 * Each non-empty line in an optional textarea can be passed as one array item;
 * titles are trimmed, blank entries are ignored, and nothing is inferred.
 */
export function createSubtaskProposal(state, parentTaskId, titles) {
  const parent = state.tasks.find((task) => task.id === parentTaskId);
  if (!parent) throw new Error(`Cannot propose subtasks: parent task "${parentTaskId}" was not found`);
  if (!Array.isArray(titles)) throw new TypeError('Subtask titles must be an array of strings');

  const cleanedTitles = titles
    .map((title) => {
      if (typeof title !== 'string') throw new TypeError('Every subtask title must be a string');
      return title.trim();
    })
    .filter((title) => title.length > 0);
  const items = cleanedTitles.map((title, index) => ({
    id: `draft-${index}`,
    parentTaskId,
    title,
  }));

  return {
    parentTaskId,
    items: normalizeOrder(items),
    removed: [],
  };
}

/** Edit a draft title. Empty edits are ignored so drafts always remain tasks. */
export function editProposedSubtask(proposal, itemId, title) {
  if (typeof title !== 'string' || !title.trim()) return proposal;
  if (!proposal.items.some((item) => item.id === itemId)) return proposal;
  return {
    ...proposal,
    items: proposal.items.map((item) => item.id === itemId ? { ...item, title: title.trim() } : item),
  };
}

/** Add a single explicitly supplied title to a draft. */
export function addProposedSubtask(proposal, title) {
  if (typeof title !== 'string' || !title.trim()) return proposal;
  const usedIds = new Set([
    ...proposal.items.map((item) => item.id),
    ...proposal.removed.map(({ item }) => item.id),
  ]);
  let suffix = 0;
  while (usedIds.has(`draft-${suffix}`)) suffix += 1;
  const item = {
    id: `draft-${suffix}`,
    parentTaskId: proposal.parentTaskId,
    title: title.trim(),
    order: proposal.items.length,
  };
  return { ...proposal, items: [...proposal.items, item] };
}

/** Move a draft item to a zero-based position, clamped to the current list. */
export function reorderProposedSubtask(proposal, itemId, toIndex) {
  const fromIndex = proposal.items.findIndex((item) => item.id === itemId);
  if (fromIndex < 0 || !Number.isFinite(toIndex) || proposal.items.length < 2) return proposal;
  const items = [...proposal.items];
  const [item] = items.splice(fromIndex, 1);
  const insertionIndex = Math.max(0, Math.min(items.length, Math.trunc(toIndex)));
  items.splice(insertionIndex, 0, item);
  return { ...proposal, items: normalizeOrder(items) };
}

/** Remove a draft item while retaining enough information to undo it. */
export function removeProposedSubtask(proposal, itemId) {
  const index = proposal.items.findIndex((item) => item.id === itemId);
  if (index < 0) return proposal;
  const [item] = proposal.items.slice(index, index + 1);
  return {
    ...proposal,
    items: normalizeOrder(proposal.items.filter((candidate) => candidate.id !== itemId)),
    removed: [...proposal.removed, { item, index }],
  };
}

/** Undo the most recent draft removal and restore its prior position. */
export function undoProposedSubtaskRemoval(proposal) {
  if (proposal.removed.length === 0) return proposal;
  const removed = proposal.removed.at(-1);
  const items = [...proposal.items];
  items.splice(Math.max(0, Math.min(items.length, removed.index)), 0, removed.item);
  return {
    ...proposal,
    items: normalizeOrder(items),
    removed: proposal.removed.slice(0, -1),
  };
}

/** Cancel a transient draft. No task state has been changed, so keep its identity. */
export function cancelSubtaskProposal(state) {
  return state;
}

/**
 * Accept a proposal by appending children to its parent. The caller supplies
 * one unique persistent ID per draft item. Parent fields, including status,
 * remain untouched; no schedule, duration, category, or deadline is inferred.
 */
export function commitSubtaskProposal(state, proposal, taskIds) {
  const parent = state.tasks.find((task) => task.id === proposal.parentTaskId);
  if (!parent) throw new Error(`Cannot accept subtasks: parent task "${proposal.parentTaskId}" was not found`);
  if (!Array.isArray(taskIds) || taskIds.length !== proposal.items.length) {
    throw new TypeError('Provide exactly one persistent task ID for each proposed subtask');
  }
  if (taskIds.some((id) => typeof id !== 'string' || !id)
    || new Set(taskIds).size !== taskIds.length
    || taskIds.some((id) => state.tasks.some((task) => task.id === id))) {
    throw new Error('Persistent subtask IDs must be non-empty and unique');
  }

  const existing = childrenOf(state, proposal.parentTaskId).map(({ task }) => task);
  const firstOrder = existing.length;
  const existingOrderById = new Map(existing.map((task, index) => [task.id, index]));
  const tasks = proposal.items.map((item, index) => ({
    id: taskIds[index],
    title: item.title,
    durationMinutes: 0,
    category: '',
    deadline: '',
    scheduledDate: '',
    startTime: '',
    status: 'open',
    notes: '',
    parentTaskId: proposal.parentTaskId,
    order: firstOrder + index,
  }));

  const orderedTasks = state.tasks.map((task) => existingOrderById.has(task.id)
    ? { ...task, order: existingOrderById.get(task.id) }
    : task);
  return { state: { ...state, tasks: [...orderedTasks, ...tasks] }, tasks };
}

/** Return active subtasks in displayed order. */
export function getSubtasks(state, parentTaskId) {
  return childrenOf(state, parentTaskId).map(({ task }) => task);
}

/** Edit a committed child title without changing its parent or other fields. */
export function editSubtask(state, subtaskId, title) {
  const current = state.tasks.find((task) => task.id === subtaskId && task.parentTaskId);
  if (!current || current.status === 'removed' || typeof title !== 'string' || !title.trim()) return state;
  return {
    ...state,
    tasks: state.tasks.map((task) => task.id === subtaskId ? { ...task, title: title.trim() } : task),
  };
}

/** Reorder one active child within its parent's active children. */
export function reorderSubtask(state, parentTaskId, subtaskId, toIndex) {
  const children = childrenOf(state, parentTaskId).map(({ task }) => task);
  const fromIndex = children.findIndex((task) => task.id === subtaskId);
  if (fromIndex < 0 || !Number.isFinite(toIndex) || children.length < 2) return state;
  const [task] = children.splice(fromIndex, 1);
  const insertionIndex = Math.max(0, Math.min(children.length, Math.trunc(toIndex)));
  children.splice(insertionIndex, 0, task);
  return updateChildOrders(state, parentTaskId, children);
}

/** Soft-remove a child, preserving its prior status so removal can be undone. */
export function removeSubtask(state, subtaskId) {
  const current = state.tasks.find((task) => task.id === subtaskId && task.parentTaskId);
  if (!current || current.status === 'removed') return state;
  return {
    ...state,
    tasks: state.tasks.map((task) => task.id === subtaskId
      ? { ...task, statusBeforeRemoval: task.status, status: 'removed' }
      : task),
  };
}

/** Restore a removed child to its prior status (or open for older removed data). */
export function undoRemoveSubtask(state, subtaskId) {
  const current = state.tasks.find((task) => task.id === subtaskId && task.parentTaskId && task.status === 'removed');
  if (!current) return state;
  const { statusBeforeRemoval = 'open', ...rest } = current;
  return {
    ...state,
    tasks: state.tasks.map((task) => task.id === subtaskId
      ? { ...rest, status: statusBeforeRemoval }
      : task),
  };
}
