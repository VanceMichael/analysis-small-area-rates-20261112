import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBatch, createState, rebuildAnalysis, withdrawBatch } from '../src/updates.js';

const policy = {
  trainThrough: 6, asOf: 10, threshold: 0.8, poolBy: ['region', 'service'],
  standardWeights: { north: 0.5, south: 0.5 },
};
const record = (id, patch = {}) => ({
  id, point: 'p0', region: 'north', service: 'card', period: 1,
  success: 1, attempts: 2, as_of: 2, revision: 1, reset: false, ...patch,
});

test('每批只能更新一次，重复批次与重复记录被拒绝', () => {
  const state = createState(policy);
  const once = applyBatch(state, { batchId: 'b1', records: [record('r1')] });
  assert.equal(once.state.batches.length, 1);
  assert.throws(() => applyBatch(once.state, { batchId: 'b1', records: [record('r2')] }), /只能更新一次/);
  assert.throws(() => applyBatch(once.state, { batchId: 'b2', records: [record('r1')] }), /已存在/);
  assert.throws(() => applyBatch(once.state, { batchId: '', records: [] }), /batchId/);
});

test('追加未来数据不反改过去分析（as_of 隔离）', () => {
  const state = createState(policy);
  const first = applyBatch(state, { batchId: 'b1', records: [
    record('r1', { period: 1, success: 1, attempts: 2 }),
    record('r2', { period: 2, success: 3, attempts: 5, as_of: 3 }),
  ] });
  const before = rebuildAnalysis(first.state);
  const future = applyBatch(first.state, { batchId: 'b2', records: [
    record('r3', { period: 2, success: 99, attempts: 100, as_of: 11, revision: 9, reset: true }),
  ] });
  const after = rebuildAnalysis(future.state);
  assert.deepEqual(after.ledger.futureRecordIds, ['r3']);
  assert.equal(after.ledger.legalRecordCount, before.ledger.legalRecordCount);
  assert.deepEqual(
    after.analysis.points.map(point => [point.point, point.success, point.attempts]),
    before.analysis.points.map(point => [point.point, point.success, point.attempts]),
  );
  assert.deepEqual(after.priors.priorByLayer, before.priors.priorByLayer);
});

test('撤回历史批次后可用剩余原始记录重建后验', () => {
  const state = createState(policy);
  const b1 = applyBatch(state, { batchId: 'b1', records: [record('r1', { period: 1, success: 1, attempts: 2 })] });
  const b2 = applyBatch(b1.state, { batchId: 'b2', records: [
    { ...record('r2'), period: 2, success: 3, attempts: 5, as_of: 3 },
  ] });
  const rebuilt = rebuildAnalysis(b2.state);
  assert.equal(rebuilt.analysis.points[0].attempts, 5);
  const withdrawn = withdrawBatch(b2.state, 'b1');
  assert.equal(withdrawn.state.records.length, 1);
  assert.deepEqual(withdrawn.withdrawnRecordIds, ['r1']);
  const rebuiltAfterWithdraw = rebuildAnalysis(withdrawn.state);
  // 撤回期 1 后只剩期 2 的累计台账（3/5），该期即重建起点
  assert.equal(rebuiltAfterWithdraw.analysis.points[0].attempts, 5);
  assert.equal(rebuiltAfterWithdraw.analysis.points[0].success, 3);
  assert.equal(rebuiltAfterWithdraw.updateLog.length, 1);
  assert.throws(() => withdrawBatch(b2.state, 'missing'), /不存在/);
});

test('状态保存训练窗口、先验与更新日志，可从原始记录完整复算', () => {
  const state = createState(policy);
  const next = applyBatch(state, { batchId: 'b1', appliedAt: 10, records: [
    record('r1', { period: 1, success: 2, attempts: 4 }),
    record('r2', { period: 2, success: 5, attempts: 9, as_of: 3 }),
  ] });
  const result = rebuildAnalysis(next.state);
  assert.equal(result.asOf, 10);
  assert.deepEqual(result.updateLog, [{ batchId: 'b1', appliedAt: 10, recordIds: ['r1', 'r2'], recordCount: 2 }]);
  assert.equal(result.priors.trainingWindow.through, 6);
  assert.ok(result.inputFingerprint.length === 64);
  // 同一状态重复复算结果一致
  assert.deepEqual(rebuildAnalysis(next.state), result);
});

test('历史更正以新 id 高修订进入，旧修订被替代而非相加', () => {
  const state = createState(policy);
  const b1 = applyBatch(state, { batchId: 'b1', records: [record('r1', { success: 2, attempts: 4, revision: 1 })] });
  const b2 = applyBatch(b1.state, { batchId: 'b2', records: [record('r2', { success: 3, attempts: 5, revision: 2, as_of: 3 })] });
  const result = rebuildAnalysis(b2.state);
  assert.deepEqual(result.ledger.supersededRecordIds, ['r1']);
  const point = result.analysis.points[0];
  assert.equal(point.success, 3);
  assert.equal(point.attempts, 5);
});
