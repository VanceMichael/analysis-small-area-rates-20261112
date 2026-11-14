// 更新状态机：每批记录只能登记一次；撤回批次后用剩余原始记录重建台账与后验。
// 训练窗口、先验估计与更新批次共同保存在状态里，保证任何分析都能从原始上报复算。

import { fingerprint, validateRecords } from './dataset.js';
import { reconstructLedger } from './ledger.js';
import { estimatePriors } from './prior.js';
import { analyze } from './model.js';

export function createState(policy) {
  return {
    version: 1,
    policy,
    batches: [],
    records: [],
  };
}

// 一批一次：batchId 不可重复，记录 id 全局唯一；更正历史期的数据应作为新 id、更高 revision 的新记录进入。
export function applyBatch(state, batch) {
  if (!batch || typeof batch.batchId !== 'string' || batch.batchId.length === 0) {
    throw new Error('批次必须带非空 batchId');
  }
  if (state.batches.some(entry => entry.batchId === batch.batchId)) {
    throw new Error(`批次 ${batch.batchId} 已登记，每批只能更新一次`);
  }
  validateRecords(batch.records);
  const knownIds = new Set(state.records.map(record => record.id));
  const batchIds = new Set();
  for (const record of batch.records) {
    if (knownIds.has(record.id) || batchIds.has(record.id)) {
      throw new Error(`记录 ${record.id} 已存在；历史更正请用新记录 id 和更高 revision 上报`);
    }
    batchIds.add(record.id);
  }
  const next = {
    ...state,
    batches: [...state.batches, {
      batchId: batch.batchId,
      appliedAt: batch.appliedAt ?? null,
      recordIds: batch.records.map(record => record.id),
      recordCount: batch.records.length,
    }],
    records: [...state.records, ...batch.records],
  };
  return { state: next, inputFingerprint: fingerprint(next.records) };
}

// 撤回：移除整批及其原始记录，保留其他批次顺序；之后可直接重建后验。
export function withdrawBatch(state, batchId) {
  if (!state.batches.some(entry => entry.batchId === batchId)) {
    throw new Error(`批次 ${batchId} 不存在，无法撤回`);
  }
  const target = state.batches.find(entry => entry.batchId === batchId);
  const removed = new Set(target.recordIds);
  return {
    state: {
      ...state,
      batches: state.batches.filter(entry => entry.batchId !== batchId),
      records: state.records.filter(record => !removed.has(record.id)),
    },
    withdrawnRecordIds: target.recordIds,
  };
}

// 从状态内全部原始记录复算：选合法修订 -> 期间增量 -> 训练窗先验 -> 后验与排序。
// asOf 固定时，as_of 更晚的“未来”修订对本次分析不可见，因此追加数据不会反改过去分析。
export function rebuildAnalysis(state, options = {}) {
  const { policy } = state;
  const asOf = options.asOf ?? policy.asOf;
  const ledger = reconstructLedger(state.records, asOf);
  const priorEstimation = estimatePriors(ledger.increments, {
    trainThrough: policy.trainThrough,
    poolBy: policy.poolBy,
  });
  const analysis = analyze(ledger.increments, priorEstimation, policy, options.monteCarlo);
  return {
    version: 1,
    asOf,
    inputFingerprint: fingerprint(state.records),
    ledger: {
      legalRecordCount: ledger.legal.length,
      supersededRecordIds: ledger.superseded,
      futureRecordIds: ledger.future,
      resets: ledger.resets,
      increments: ledger.increments,
    },
    priors: priorEstimation,
    analysis,
    updateLog: state.batches,
  };
}
