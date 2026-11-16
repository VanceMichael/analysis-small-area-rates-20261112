import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconstructLedger, selectLegalRevisions, splitWindow } from '../src/ledger.js';

const cases = JSON.parse(await readFile('data/case-records.json', 'utf8')).records;

function find(records, point, period, revision = 1) {
  return records.find(row => row.point === point && row.period === period && row.revision === revision);
}

test('as_of 截止剔除未来上报，同期取最大 revision', () => {
  const { series, droppedAsFuture, superseded } = selectLegalRevisions(cases, 10);
  assert.deepEqual(droppedAsFuture, ['e0009']); // A 期间 8 的 rev2 在 as_of=11
  const aPeriodTwo = series.get('A').find(row => row.period === 2);
  assert.equal(aPeriodTwo.id, 'e0002');
  assert.deepEqual(superseded, [{ point: 'A', period: 2, replacedId: 'e0001', keptId: 'e0002' }]);
  // 截止放到 11，rev2 合法，rev1 被替代
  const later = selectLegalRevisions(cases, 11);
  assert.deepEqual(later.droppedAsFuture, []);
  assert.equal(later.series.get('A').find(row => row.period === 8).id, 'e0009');
});

test('同 revision 冲突直接拒绝，不静默选边', () => {
  const duplicate = [...cases, { ...find(cases, 'B', 1), id: 'dup1', as_of: 2 }];
  assert.throws(() => selectLegalRevisions(duplicate, 10), /无法选择合法修订/);
});

test('累计台账还原为互不重叠增量，累计值从不相加', () => {
  const ledger = reconstructLedger(cases, 10);
  const a = ledger.points.find(item => item.point === 'A');
  const deltas = a.increments.map(item => [item.period, item.deltaSuccess, item.deltaAttempts, item.startFresh]);
  // 期间2 取修订后 10/20：p1=5/10 -> 增量 5/10；p3 14/28 -> 4/8；p4 reset -> 3/6
  assert.deepEqual(deltas, [
    [1, 5, 10, true],
    [2, 5, 10, false],
    [3, 4, 8, false],
    [4, 3, 6, true],
    [5, 3, 6, false],
    [6, 3, 6, false],
    [7, 3, 6, false],
    [8, 3, 6, false]
  ]);
  assert.deepEqual(a.totals, { success: 29, attempts: 58 });
  assert.deepEqual(a.resets.map(item => item.period), [4]);
  // 零尝试期间增量为 0/0，不产生伪造成功
  const c = ledger.points.find(item => item.point === 'C');
  assert.deepEqual(c.increments.find(item => item.period === 7).deltaAttempts, 0);
});

test('重置点的重置前累计值被保留在审计信息里', () => {
  const ledger = reconstructLedger(cases, 10);
  const reset = ledger.audit.resets[0];
  assert.equal(reset.point, 'A');
  assert.deepEqual([reset.priorCumulativeSuccess, reset.priorCumulativeAttempts], [14, 28]);
  assert.equal(ledger.audit.resetCount, 1);
});

test('未标记 reset 的累计回退被拒绝', () => {
  const bad = [
    { id: 'b1', point: 'X', region: 'north', service: 'card', period: 1, success: 5, attempts: 10, as_of: 2, revision: 1, reset: false },
    { id: 'b2', point: 'X', region: 'north', service: 'card', period: 2, success: 4, attempts: 9, as_of: 3, revision: 1, reset: false }
  ];
  assert.throws(() => reconstructLedger(bad, 10), /累计值回退/);
  // 同样的数据显式 reset 后合法
  const fixed = [{ ...bad[1], reset: true }];
  const ledger = reconstructLedger([bad[0], ...fixed], 10);
  assert.deepEqual(ledger.points[0].totals, { success: 9, attempts: 19 });
});

test('success 大于 attempts 等非法台账被拒绝', () => {
  const bad = [{ id: 'x', point: 'X', region: 'north', service: 'card', period: 1, success: 9, attempts: 8, as_of: 2, revision: 1, reset: false }];
  assert.throws(() => reconstructLedger(bad, 10), /不合法/);
});

test('训练/分析窗口按 trainThrough 切分且不重不漏', () => {
  const ledger = reconstructLedger(cases, 10);
  const c = ledger.points.find(item => item.point === 'C');
  const windows = splitWindow(c, 6);
  assert.deepEqual(windows.training, { success: 20, attempts: 48 });
  assert.deepEqual(windows.analysis, { success: 4, attempts: 8 });
  assert.deepEqual(windows.trainingPeriods, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(windows.analysisPeriods, [7, 8]);
  // 新点 N 没有训练窗口
  const n = ledger.points.find(item => item.point === 'N');
  const nWindows = splitWindow(n, 6);
  assert.deepEqual(nWindows.training, { success: 0, attempts: 0 });
  assert.deepEqual(nWindows.analysis, { success: 2, attempts: 2 });
});

test('region/service 在期间之间漂移被拒绝', () => {
  const drift = [
    { id: 'd1', point: 'X', region: 'north', service: 'card', period: 1, success: 1, attempts: 2, as_of: 2, revision: 1, reset: false },
    { id: 'd2', point: 'X', region: 'south', service: 'card', period: 2, success: 2, attempts: 4, as_of: 3, revision: 1, reset: false }
  ];
  assert.throws(() => reconstructLedger(drift, 10), /分层口径不稳定/);
});

test('重建结果只依赖合法数据，输入行序无关', () => {
  const first = reconstructLedger(cases, 10);
  const second = reconstructLedger([...cases].reverse(), 10);
  assert.deepEqual(first.points.map(item => item.totals), second.points.map(item => item.totals));
});
