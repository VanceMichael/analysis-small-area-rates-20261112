import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLegalRevisions, reconstructPoint, reconstructLedger } from '../src/ledger.js';

const seed = {
  point: 'p0', region: 'north', service: 'card', period: 1,
  success: 1, attempts: 3, as_of: 2, revision: 1, reset: false, id: 'r0',
};
const row = (id, patch) => ({ ...seed, id, ...patch });

test('按 as_of 选合法修订：未来修订不可见，高修订号替代低修订号', () => {
  const records = [
    row('r1', { success: 1, attempts: 3, revision: 1, as_of: 2 }),
    row('r2', { success: 2, attempts: 4, revision: 2, as_of: 5 }),
    row('r3', { success: 9, attempts: 9, revision: 9, as_of: 11 }),
  ];
  const atFive = selectLegalRevisions(records, 5);
  assert.equal(atFive.legal.length, 1);
  assert.equal(atFive.legal[0].id, 'r2');
  assert.deepEqual(atFive.superseded, ['r1']);
  assert.deepEqual(atFive.future, ['r3']);
  const atTen = selectLegalRevisions(records, 10);
  assert.equal(atTen.legal[0].id, 'r2');
  assert.deepEqual(atTen.future, ['r3']);
});

test('同修订号同 as_of 的冲突值被拒绝', () => {
  const records = [row('r1', { revision: 1, as_of: 2, success: 1 }),
    row('r2', { revision: 1, as_of: 2, success: 2 })];
  assert.throws(() => selectLegalRevisions(records, 10), /冲突/);
});

test('期间增量互不重叠：累计值不相加，只做差分', () => {
  const rows = [
    row('r1', { period: 1, success: 2, attempts: 5 }),
    row('r2', { period: 2, success: 5, attempts: 11 }),
    row('r3', { period: 3, success: 6, attempts: 14 }),
  ];
  const increments = reconstructPoint(rows);
  assert.deepEqual(increments.map(item => [item.successDelta, item.attemptsDelta]),
    [[2, 5], [3, 6], [1, 3]]);
  // 增量合计等于期末累计，而非累计行相加
  assert.equal(increments.reduce((sum, item) => sum + item.attemptsDelta, 0), 14);
});

test('重置期增量等于重置后台账值，并带显式标记', () => {
  const rows = [
    row('r1', { period: 1, success: 5, attempts: 10 }),
    row('r2', { period: 2, success: 3, attempts: 6, reset: true }),
    row('r3', { period: 3, success: 4, attempts: 8 }),
  ];
  const increments = reconstructPoint(rows);
  assert.deepEqual(increments.map(item => [item.successDelta, item.attemptsDelta, item.reset]),
    [[5, 10, false], [3, 6, true], [1, 2, false]]);
  assert.equal(increments[1].reset, true);
});

test('未标记重置的累计回退被拒绝', () => {
  const rows = [
    row('r1', { period: 1, success: 5, attempts: 10 }),
    row('r2', { period: 2, success: 4, attempts: 9 }),
  ];
  assert.throws(() => reconstructPoint(rows), /回退/);
});

test('零尝试台账合法且增量为零', () => {
  const rows = [
    row('r1', { period: 1, success: 0, attempts: 0 }),
    row('r2', { period: 2, success: 0, attempts: 0 }),
    row('r3', { period: 3, success: 1, attempts: 2 }),
  ];
  const increments = reconstructPoint(rows);
  assert.deepEqual(increments.map(item => item.attemptsDelta), [0, 0, 2]);
});

test('完整台账重建：修订替代、未来隔离与重置标记同时生效并守恒', async () => {
  const records = [
    row('r1', { period: 1, success: 2, attempts: 4, revision: 1, as_of: 2 }),
    row('r2', { period: 1, success: 3, attempts: 5, revision: 2, as_of: 3 }),
    row('r3', { period: 2, success: 4, attempts: 7, revision: 1, as_of: 4 }),
    row('r4', { period: 2, success: 99, attempts: 100, revision: 9, as_of: 11, reset: true }),
  ];
  const ledger = reconstructLedger(records, 10);
  assert.equal(ledger.legal.length, 2);
  assert.deepEqual(ledger.superseded, ['r1']);
  assert.deepEqual(ledger.future, ['r4']);
  const point = ledger.increments.filter(item => item.point === 'p0');
  assert.deepEqual(point.map(item => [item.successDelta, item.attemptsDelta]), [[3, 5], [1, 2]]);
  assert.deepEqual(ledger.resets, []);
});

test('成功增量超过尝试增量被拒绝', () => {
  const rows = [
    row('r1', { period: 1, success: 1, attempts: 2 }),
    row('r2', { period: 2, success: 4, attempts: 3 }),
  ];
  assert.throws(() => reconstructPoint(rows), /回退|成功增量|不合法/);
});
