import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addProposedSubtask,
  cancelSubtaskProposal,
  commitSubtaskProposal,
  createSubtaskProposal,
  editProposedSubtask,
  editSubtask,
  getSubtasks,
  reorderProposedSubtask,
  reorderSubtask,
  removeProposedSubtask,
  removeSubtask,
  undoProposedSubtaskRemoval,
  undoRemoveSubtask,
} from '../src/subtasks.js';

function stateWithParent(status = 'open') {
  return {
    tasks: [
      {
        id: 'parent', title: 'Prepare proposal', status, durationMinutes: 45,
        scheduledDate: '2026-10-30', deadline: '2026-10-31T17:00', notes: 'keep this',
      },
    ],
    captures: [],
  };
}

test('manual proposal contains only supplied titles and can be edited, reordered, removed, and restored', () => {
  const original = stateWithParent();
  let proposal = createSubtaskProposal(original, 'parent', [' Collect figures ', '', 'Ask Sam, if needed']);

  assert.deepEqual(proposal.items.map(({ title, order }) => ({ title, order })), [
    { title: 'Collect figures', order: 0 },
    { title: 'Ask Sam, if needed', order: 1 },
  ]);
  assert.equal(proposal.parentTaskId, 'parent');
  assert.equal(original.tasks.length, 1, 'proposal creation must not persist tasks');

  proposal = editProposedSubtask(proposal, 'draft-0', 'Read the supplied file');
  proposal = reorderProposedSubtask(proposal, 'draft-1', 0);
  proposal = addProposedSubtask(proposal, 'Check the listed dates');
  assert.deepEqual(proposal.items.map(({ title, order }) => ({ title, order })), [
    { title: 'Ask Sam, if needed', order: 0 },
    { title: 'Read the supplied file', order: 1 },
    { title: 'Check the listed dates', order: 2 },
  ]);

  proposal = removeProposedSubtask(proposal, 'draft-0');
  assert.deepEqual(proposal.items.map((item) => item.title), ['Ask Sam, if needed', 'Check the listed dates']);
  proposal = undoProposedSubtaskRemoval(proposal);
  assert.deepEqual(proposal.items.map(({ title, order }) => ({ title, order })), [
    { title: 'Ask Sam, if needed', order: 0 },
    { title: 'Read the supplied file', order: 1 },
    { title: 'Check the listed dates', order: 2 },
  ]);
  assert.equal(undoProposedSubtaskRemoval(proposal), proposal, 'undo with no history is a no-op');
});

test('cancel preserves the original state and does not add any proposed child', () => {
  const original = stateWithParent();
  createSubtaskProposal(original, 'parent', ['Do the explicitly supplied step']);
  assert.equal(cancelSubtaskProposal(original), original);
  assert.deepEqual(original.tasks.map((task) => task.id), ['parent']);
});

test('accept links user-entered subtasks and leaves the parent complete with no inferred task facts', () => {
  const original = stateWithParent('done');
  const proposal = createSubtaskProposal(original, 'parent', ['Send the draft', 'Archive the response']);
  const { state, tasks } = commitSubtaskProposal(original, proposal, ['child-1', 'child-2']);

  assert.deepEqual(tasks.map(({ id, title, parentTaskId, order }) => ({ id, title, parentTaskId, order })), [
    { id: 'child-1', title: 'Send the draft', parentTaskId: 'parent', order: 0 },
    { id: 'child-2', title: 'Archive the response', parentTaskId: 'parent', order: 1 },
  ]);
  assert.ok(tasks.every((task) => task.durationMinutes === 0
    && task.category === ''
    && task.deadline === ''
    && task.scheduledDate === ''
    && task.startTime === ''
    && task.notes === ''
    && task.status === 'open'));
  assert.equal(state.tasks.find((task) => task.id === 'parent').status, 'done');
  assert.deepEqual(original.tasks.map((task) => task.id), ['parent'], 'commit must be immutable');
  assert.deepEqual(getSubtasks(state, 'parent').map((task) => task.id), ['child-1', 'child-2']);
});

test('committed child edit, reorder, removal, and undo leave parent completion and history intact', () => {
  const original = stateWithParent('done');
  const proposal = createSubtaskProposal(original, 'parent', ['One', 'Two', 'Three']);
  let state = commitSubtaskProposal(original, proposal, ['one', 'two', 'three']).state;
  state = editSubtask(state, 'two', 'Two (edited)');
  state = reorderSubtask(state, 'parent', 'three', 0);
  assert.deepEqual(getSubtasks(state, 'parent').map((task) => task.title), ['Three', 'One', 'Two (edited)']);

  state = removeSubtask(state, 'two');
  assert.deepEqual(getSubtasks(state, 'parent').map((task) => task.title), ['Three', 'One']);
  state = undoRemoveSubtask(state, 'two');
  assert.deepEqual(getSubtasks(state, 'parent').map((task) => task.title), ['Three', 'One', 'Two (edited)']);
  assert.equal(state.tasks.find((task) => task.id === 'parent').status, 'done');
  assert.equal(state.tasks.find((task) => task.id === 'parent').notes, 'keep this');
  assert.equal(undoRemoveSubtask(state, 'two'), state, 'undo of a live child is a no-op');
});

test('invalid parent and duplicate persistent IDs are rejected without mutating state', () => {
  const original = stateWithParent();
  assert.throws(() => createSubtaskProposal(original, 'missing', ['Manual step']), /parent task/);

  const proposal = createSubtaskProposal(original, 'parent', ['First', 'Second']);
  assert.throws(() => commitSubtaskProposal(original, proposal, ['same', 'same']), /unique/);
  assert.throws(() => commitSubtaskProposal(original, proposal, ['one']), /exactly one/);
  assert.deepEqual(original.tasks.map((task) => task.id), ['parent']);
});
