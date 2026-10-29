import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCapture,
  acceptCaptureProposal,
  createDemoState,
  createCaptureProposal,
  isReferenceCaptureText,
  loadState,
  parseCapture,
  removeTask,
  reorderCaptureTask,
  reminderAt,
  saveState,
  STORAGE_KEY,
  parseBackup,
} from '../src/model.js';

test('capture parsing splits lines and comma separated thoughts without inventing metadata', () => {
  assert.deepEqual(parseCapture('call the bank, budget\ngym legs; dentist sometime'), [
    'call the bank', 'budget', 'gym legs', 'dentist sometime',
  ]);
});

test('reference brain-dump copy is identifiable so it can stay display-only', () => {
  const example = 'call the bank re card, budget, gym legs, reply to Marc, buy birthday card, dentist sometime';
  assert.equal(isReferenceCaptureText(example), true);
  assert.equal(isReferenceCaptureText(`${example}, buy milk`), false);
  assert.equal(isReferenceCaptureText(''), false);
});

test('capture proposal is review-only; acceptance creates selected tasks and preserves the exact source', () => {
  const initial = createDemoState();
  const source = '\ncall the bank re card, dentist sometime; budget\n';
  const proposal = createCaptureProposal(source);

  assert.deepEqual(proposal.items.map((item) => item.title), ['call the bank re card', 'dentist sometime', 'budget']);
  assert.equal(initial.captures.length, 0, 'proposing a split does not write a capture');
  assert.equal(initial.tasks.length, 5, 'proposing a split does not create tasks');

  const result = acceptCaptureProposal(initial, proposal, [
    { id: proposal.items[0].id, title: 'Call the bank about the card' },
    { id: proposal.items[2].id, title: 'Prepare the budget' },
  ], '2026-10-29T10:00:00.000Z');

  assert.equal(result.capture.text, source, 'the complete source remains unchanged');
  assert.deepEqual(result.tasks.map((task) => task.title), ['Call the bank about the card', 'Prepare the budget']);
  assert.equal(result.tasks[0].parentCaptureId, result.capture.id);
  assert.equal(result.tasks[1].parentCaptureId, result.capture.id);
  assert.deepEqual(result.tasks.map((task) => task.order), [0, 1]);
  assert.ok(result.tasks.every((task) => task.durationMinutes === 0 && task.category === '' && task.deadline === ''));
  assert.ok(result.tasks.every((task) => task.scheduledDate === '' && task.startTime === '' && task.status === 'open'));
  assert.equal(initial.captures.length, 0, 'acceptance does not mutate its input state');
  assert.equal(initial.tasks.length, 5);
});

test('canceling or accepting no capture candidates creates no capture or tasks', () => {
  const initial = createDemoState();
  const proposal = createCaptureProposal('call the bank, dentist sometime');
  const result = acceptCaptureProposal(initial, proposal, []);

  assert.equal(result.capture, null);
  assert.deepEqual(result.tasks, []);
  assert.equal(result.state, initial, 'cancel leaves the draft state untouched');
  assert.equal(initial.captures.length, 0);
  assert.equal(initial.tasks.length, 5);
});

test('capture draft persists locally without creating tasks or captures', () => {
  const values = new Map();
  const storage = { setItem: (key, value) => values.set(key, value), getItem: (key) => values.get(key) ?? null };
  const draft = 'call the bank re card, dentist sometime';
  const saved = saveState(storage, { ...createDemoState(), captureDraft: draft });
  const loaded = loadState(storage);

  assert.equal(saved.captureDraft, draft);
  assert.equal(loaded.captureDraft, draft);
  assert.deepEqual(saved.tasks, [], 'untouched sample tasks are not promoted while saving a draft');
  assert.deepEqual(saved.captures, [], 'a draft does not become a saved capture before acceptance');
});

test('captured subtasks retain a link to the untouched source and start unscheduled', () => {
  const { state, capture, tasks } = addCapture(createDemoState(), 'call bank, budget', '2026-10-29T10:00:00.000Z');
  assert.equal(capture.text, 'call bank, budget');
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((task) => task.parentCaptureId === capture.id));
  assert.ok(tasks.every((task) => task.scheduledDate === '' && task.status === 'open'));
  assert.ok(tasks.every((task) => task.durationMinutes === 0 && task.deadline === ''));
  assert.equal(state.demoData, true, 'capturing new thoughts must not promote untouched demo tasks');
  assert.equal(state.captures.at(-1).text, capture.text);

  const values = new Map();
  const saved = saveState({ setItem: (key, value) => values.set(key, value) }, state);
  assert.equal(saved.tasks.length, 2, 'new captured subtasks survive while untouched demo tasks are filtered');
  assert.ok(saved.tasks.every((task) => task.parentCaptureId === capture.id));
});

test('linked subtasks can be reordered and removed without deleting the capture', () => {
  let state = addCapture(createDemoState(), 'first, second, third').state;
  const capture = state.captures[0];
  const children = state.tasks.filter((task) => task.parentCaptureId === capture.id);
  state = reorderCaptureTask(state, capture.id, children[1].id, -1);
  assert.deepEqual(state.tasks.filter((task) => task.parentCaptureId === capture.id).sort((a, b) => a.order - b.order).map((task) => task.title), ['second', 'first', 'third']);
  state = removeTask(state, children[0].id);
  assert.equal(state.tasks.find((task) => task.id === children[0].id).status, 'removed');
  assert.equal(state.captures[0].text, 'first, second, third');
});

test('saved local state round-trips and invalid state falls back to the reference demo', () => {
  const values = new Map();
  const storage = { setItem: (key, value) => values.set(key, value), getItem: (key) => values.get(key) ?? null };
  const saved = saveState(storage, createDemoState());
  assert.equal(saved.demoData, false);
  assert.equal(saved.tasks.length, 0, 'untouched sample tasks are not promoted to personal data');
  assert.equal(loadState(storage).tasks.length, 0);
  values.set(STORAGE_KEY, '{broken');
  assert.equal(loadState(storage).demoData, true);
});

test('saving demo state keeps edited and completed sample tasks plus genuine new tasks', () => {
  const demo = createDemoState();
  const state = {
    ...demo,
    tasks: [
      { ...demo.tasks[0], title: 'Revise the budget summary' },
      { ...demo.tasks[1], status: 'done', completedAt: '2026-10-29T15:10:00.000Z' },
      ...demo.tasks.slice(2),
      { id: 'new-task', title: 'New personal task', status: 'open', durationMinutes: 20 },
    ],
  };
  const values = new Map();
  const saved = saveState({ setItem: (key, value) => values.set(key, value) }, state);

  assert.deepEqual(saved.tasks.map((task) => task.id), ['budget', 'reply', 'new-task']);
  assert.equal(saved.tasks[0].title, 'Revise the budget summary');
  assert.equal(saved.tasks[1].status, 'done');
  assert.equal(saved.tasks[2].title, 'New personal task');
  assert.equal(state.tasks.length, 6, 'saving does not mutate the in-memory state');
  assert.equal(JSON.parse(values.get(STORAGE_KEY)).tasks.length, 3);
});

test('saving existing non-demo state preserves all its tasks, including demo-shaped records', () => {
  const state = { ...createDemoState(), demoData: false };
  const saved = saveState({ setItem() {} }, state);
  assert.deepEqual(saved.tasks, state.tasks);
});

test('backup import accepts Tempo state and rejects malformed or unrelated JSON', () => {
  const original=createDemoState();
  const imported=parseBackup(JSON.stringify(original));
  assert.equal(imported.demoData,false);
  assert.equal(imported.tasks.length,original.tasks.length);
  assert.equal(parseBackup('{broken'),null);
  assert.equal(parseBackup(JSON.stringify({schema:1,tasks:'no',captures:[]})),null);
});

test('the default departure reminder is scheduled two minutes before the supplied local departure time', () => {
  const departure = new Date(2026, 9, 29, 14, 0);
  const localDeparture = `${departure.getFullYear()}-${String(departure.getMonth() + 1).padStart(2, '0')}-${String(departure.getDate()).padStart(2, '0')}T14:00`;
  const reminder = new Date(reminderAt(localDeparture, 2));
  const expected = new Date(2026, 9, 29, 13, 58);
  assert.equal(reminder.getTime(), expected.getTime());
  assert.equal(reminderAt('', 2), null);
  assert.equal(reminderAt('invalid', 2), null);
});
