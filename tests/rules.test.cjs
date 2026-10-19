'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  revealThreshold,
  revealProblems,
  orderProblems,
  sanitizeHistory,
  elapsedSeconds,
} = require('../ccpc-new-board.user.js');

const problem = (problem_id, num) => ({ problem_id, num });
const stat = (status, lastSubmitTime) => ({ status, lastSubmitTime, attempts: 1 });
const row = (team_id, problemStats, team = {}) => ({
  team_id,
  team: { team_id, tkind: 0, privilege: 'default', ...team },
  problemStats,
});
const sortedIds = (ids) => [...ids].sort();

test('reveal threshold rounds upward and caps at 50 teams', () => {
  const teams = Array.from({ length: 251 }, (_, i) => ({
    team_id: `team-${i}`,
    tkind: 0,
    privilege: 'default',
  }));

  assert.equal(revealThreshold(teams.slice(0, 6)), 2);
  assert.equal(revealThreshold(teams.slice(0, 249)), 50);
  assert.equal(revealThreshold(teams), 50);
  assert.equal(revealThreshold([]), 0);
});

test('female teams count as official teams; starred teams do not affect the denominator', () => {
  const teams = [
    { team_id: 'regular', tkind: 0, privilege: '' },
    { team_id: 'female', tkind: 1, privilege: 'default' },
    ...Array.from({ length: 20 }, (_, i) => ({
      team_id: `star-${i}`,
      tkind: 2,
      privilege: 'default',
    })),
  ];
  assert.equal(revealThreshold(teams), 1);
  assert.equal(revealThreshold(teams.filter((team) => team.tkind === 2)), 0);
});

test('only participant privileges contribute to the threshold, ignoring case and spaces', () => {
  const teams = [
    { team_id: 'regular', tkind: 0, privilege: '  DeFaUlT  ' },
    { team_id: 'female', tkind: 1, privilege: '  ' },
    ...Array.from({ length: 10 }, (_, i) => ({
      team_id: `staff-${i}`,
      tkind: 0,
      privilege: i % 2 ? 'staff' : 'judge',
    })),
  ];
  assert.equal(revealThreshold(teams), 1);
  assert.equal(revealThreshold(teams.slice(2)), 0);
});

test('starred and female AC teams both contribute to problem disclosure', () => {
  const problems = [problem('a', 0), problem('b', 1)];
  const rows = [
    row('official', { a: stat('ac', '00:05:00') }),
    row('female', { a: stat('ac', '00:08:00') }, { tkind: 1 }),
    row('starred', { a: stat('ac', '00:09:00'), b: stat('wa', '00:11:00') }, { tkind: 2 }),
  ];
  assert.deepEqual(sortedIds(revealProblems(problems, rows, 3, false)), ['a']);
});

test('disclosure counts distinct AC team IDs rather than duplicate rows or failed submissions', () => {
  const problems = [problem('a', 0), problem('b', 1)];
  const rows = [
    row('same-team', { a: stat('ac', '00:05:00'), b: stat('wa', '00:10:00') }),
    row('same-team', { a: stat('ac', '00:05:00') }),
    row('other-team', { a: stat('wa', '00:12:00'), b: stat('pending', '00:13:00') }),
  ];
  assert.deepEqual(sortedIds(revealProblems(problems, rows, 2, false)), []);
  assert.deepEqual(sortedIds(revealProblems(problems, rows, 1, false)), ['a']);
});

test('staff and judge AC rows cannot disclose a problem', () => {
  const problems = [problem('a', 0)];
  const rows = [
    row('participant', { a: stat('ac', '00:05:00') }, { privilege: ' DEFAULT ' }),
    row('staff', { a: stat('ac', '00:01:00') }, { privilege: 'staff' }),
    row('judge', { a: stat('ac', '00:02:00') }, { privilege: ' JUDGE ' }),
  ];
  assert.deepEqual(sortedIds(revealProblems(problems, rows, 2, false)), []);
  assert.deepEqual(sortedIds(revealProblems(problems, rows, 1, false)), ['a']);
});

test('only problems with finite numbers can be disclosed, including when all are revealed', () => {
  const problems = [
    problem('a', 0),
    problem('b', 1),
    problem('unknown', undefined),
    problem('invalid', NaN),
    problem('infinite', Infinity),
  ];
  const rows = [row('team', Object.fromEntries(problems.map(({ problem_id }) => [
    problem_id,
    stat('ac', '00:05:00'),
  ])))];

  assert.deepEqual(sortedIds(revealProblems(problems, rows, 1, false)), ['a', 'b']);
  assert.deepEqual(sortedIds(revealProblems(problems, [], 50, true)), ['a', 'b']);
});

test('public columns follow problem numbers and include problems without submissions', () => {
  const problemMap = {
    c: problem('c', 2),
    a: problem('a', 0),
    b: problem('b', 1),
    d: problem('d', 3),
  };
  const result = orderProblems(problemMap, { b: stat('wa', '00:03:00') }, new Set(['c', 'a', 'b']));

  assert.deepEqual(result.publicIds, ['a', 'b', 'c']);
  assert.deepEqual(result.privateIds, []);
});

test('private columns show only submitted problems, with AC first and each group ordered by time', () => {
  const problemMap = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'untouched'].map((id, i) => [id, problem(id, i)]));
  const stats = {
    a: stat('wa', '00:30:00'),
    b: stat('ac', '00:20:00'),
    c: stat('pending', '00:10:00'),
    d: stat('ac', '00:05:00'),
    e: stat('wa', '00:15:00'),
  };
  const result = orderProblems(problemMap, stats, new Set());

  assert.deepEqual(result.publicIds, []);
  assert.deepEqual(result.privateIds, ['d', 'b', 'c', 'e', 'a']);
});

test('private time ties preserve stats traversal order without using the hidden problem number', () => {
  const problemMap = { a: problem('a', 0), b: problem('b', 1), c: problem('c', 2), d: problem('d', 3) };
  const stats = {
    d: stat('ac', '00:10:00'),
    b: stat('ac', '00:10:00'),
    c: stat('wa', '00:20:00'),
    a: stat('wa', '00:20:00'),
  };
  assert.deepEqual(orderProblems(problemMap, stats, new Set()).privateIds, ['d', 'b', 'c', 'a']);
});

test('disclosing a problem moves it to its shared numbered column for every team', () => {
  const problemMap = { a: problem('a', 0), b: problem('b', 1), c: problem('c', 2) };
  const revealed = new Set(['b']);
  const submitted = orderProblems(problemMap, { b: stat('wa', '00:10:00'), c: stat('ac', '00:11:00') }, revealed);
  const untouched = orderProblems(problemMap, {}, revealed);

  assert.deepEqual(submitted, { publicIds: ['b'], privateIds: ['c'] });
  assert.deepEqual(untouched, { publicIds: ['b'], privateIds: [] });
});

test('anonymous history keeps visible submission details and removes identifying IDs', () => {
  const original = [{
    problem_id: 1010,
    solution_id: 9001,
    contest_id: 100,
    in_date: '2026-10-18 09:05:00',
    result: 4,
    language: 1,
  }];
  const snapshot = structuredClone(original);
  const sanitized = sanitizeHistory(original, true, () => false);

  assert.notStrictEqual(sanitized, original);
  assert.notStrictEqual(sanitized[0], original[0]);
  assert.deepEqual(original, snapshot);
  assert.equal(sanitized[0].in_date, original[0].in_date);
  assert.equal(sanitized[0].result, 4);
  assert.equal(sanitized[0].language, 1);
  for (const key of ['problem_id', 'solution_id', 'contest_id']) {
    assert.equal(Object.hasOwn(sanitized[0], key), false, `${key} must not identify an anonymous problem`);
  }
});

test('frozen history removes alternate verdict fields and masks only frozen submissions', () => {
  const original = [
    { problem_id: 'a', solution_id: 1, contest_id: 2, in_date: '2026-10-18 12:59:59', result: 6, language: 1 },
    {
      problem_id: 'a',
      solution_id: 2,
      contest_id: 2,
      in_date: '2026-10-18 13:00:00',
      result: 4,
      language: 1,
      verdict: 'Accepted',
      originalResult: 4,
      raw_result: 4,
      judge_result: 4,
      passed: true,
      nested: { result: 4 },
    },
  ];
  const snapshot = structuredClone(original);
  const sanitized = sanitizeHistory(original, true, (submission) => submission.in_date >= '2026-10-18 13:00:00');

  assert.equal(sanitized[0].result, 6);
  assert.equal(sanitized[1].result, -1);
  assert.equal(sanitized[1].in_date, original[1].in_date);
  assert.equal(sanitized[1].language, 1);
  assert.deepEqual(Object.keys(sanitized[1]).sort(), ['in_date', 'language', 'result']);
  assert.deepEqual(original, snapshot);
});

test('public frozen history preserves problem identity while hiding verdicts', () => {
  const history = [{ problem_id: 'a', in_date: '2026-10-18 13:01:00', result: 4, language: 1, verdict: 'AC' }];
  const sanitized = sanitizeHistory(history, false, () => true);

  assert.equal(sanitized[0].problem_id, 'a');
  assert.equal(sanitized[0].result, -1);
  assert.equal(Object.hasOwn(sanitized[0], 'verdict'), false);
  assert.equal(history[0].result, 4);
});

test('elapsed time accepts hour and minute formats and sorts missing times last', () => {
  assert.equal(elapsedSeconds('01:02:03'), 3723);
  assert.equal(elapsedSeconds('02:03'), 123);
  assert.equal(elapsedSeconds('00:00:00'), 0);
  assert.equal(elapsedSeconds(undefined), Infinity);
  assert.equal(elapsedSeconds(null), Infinity);
  assert.equal(elapsedSeconds(''), Infinity);
});
