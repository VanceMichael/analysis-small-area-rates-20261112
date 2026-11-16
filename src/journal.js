// 更新日志：每批记录只接受一次；撤回保留批次痕迹并可重放重建后验。
// 训练窗口在初始化时封存，之后到达的训练期记录一律拒绝，先验只由封存窗口估计。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateRecords, fingerprint, canonical } from './dataset.js';

export const JOURNAL_VERSION = 1;

export function initializeJournal({ inputRecords, policy, inputFingerprint }) {
  validateRecords(inputRecords);
  if (!Number.isSafeInteger(policy.trainThrough) || policy.trainThrough < 0) {
    throw new Error('policy.trainThrough 必须是非负整数');
  }
  const lateTraining = inputRecords.filter(row => row.period <= policy.trainThrough && row.as_of > policy.asOf);
  if (lateTraining.length > 0) {
    throw new Error(`存在 ${lateTraining.length} 条训练期记录在 as_of=${policy.asOf} 之后才合法，训练窗口无法封存（例如 ${lateTraining[0].id}）`);
  }
  const snapshotFingerprint = fingerprint([...inputRecords].sort((a, b) => a.id.localeCompare(b.id, 'en')));
  return {
    version: JOURNAL_VERSION,
    spec: { trainThrough: policy.trainThrough, asOf: policy.asOf, poolBy: [...policy.poolBy] },
    baseFingerprint: inputFingerprint ?? snapshotFingerprint,
    snapshotFingerprint,
    baseRecords: inputRecords,
    batches: [],
    withdrawnBatches: []
  };
}

function ensureOpen(journal, batchId) {
  if (journal.batches.some(batch => batch.batchId === batchId)) {
    throw new Error(`批次 ${batchId} 已经接受过，每批记录只能更新一次`);
  }
  if (journal.withdrawnBatches.some(batch => batch.batchId === batchId)) {
    throw new Error(`批次 ${batchId} 已撤回；如需重新导入请使用新的批次号`);
  }
}

export function addBatch(journal, batchId, records) {
  if (typeof batchId !== 'string' || batchId.length === 0) throw new Error('批次号必须是非空字符串');
  validateRecords(records);
  ensureOpen(journal, batchId);
  const trainThrough = journal.spec.trainThrough;
  const inTrainingWindow = records.filter(row => row.period <= trainThrough);
  if (inTrainingWindow.length > 0) {
    throw new Error(`批次 ${batchId} 含 ${inTrainingWindow.length} 条训练期（period <= ${trainThrough}）记录；训练窗口已封存，先验不随后续数据改变`);
  }
  const recordFingerprint = fingerprint([...records].sort((a, b) => a.id.localeCompare(b.id, 'en')));
  const duplicated = journal.batches
    .filter(batch => batch.recordFingerprint === recordFingerprint)
    .map(batch => batch.batchId);
  if (duplicated.length > 0) {
    throw new Error(`批次 ${batchId} 的记录指纹与已接受批次 ${duplicated.join(', ')} 相同，禁止重复更新`);
  }
  journal.batches.push({ batchId, recordFingerprint, recordCount: records.length,
    acceptedAt: new Date().toISOString(), status: 'active', records });
  return journal;
}

export function withdrawBatch(journal, batchId) {
  const index = journal.batches.findIndex(batch => batch.batchId === batchId);
  if (index < 0) throw new Error(`批次 ${batchId} 不存在或已撤回`);
  const [batch] = journal.batches.splice(index, 1);
  journal.withdrawnBatches.push({ ...batch, status: 'withdrawn', withdrawnAt: new Date().toISOString() });
  return journal;
}

// 重放：基础台账 + 全部有效批次；撤回批次不参与，但痕迹保留在日志里。
export function activeRecords(journal) {
  return [...journal.baseRecords, ...journal.batches.flatMap(batch => batch.records)];
}

export function replayFingerprint(journal) {
  return fingerprint(activeRecords(journal).sort((a, b) => a.id.localeCompare(b.id, 'en')));
}

export async function saveJournal(path, journal) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(canonical(journal), null, 2) + '\n', { encoding: 'utf8' });
}

export async function loadJournal(path) {
  const journal = JSON.parse(await readFile(path, 'utf8'));
  if (journal.version !== JOURNAL_VERSION) throw new Error('不支持的日志版本');
  for (const batch of journal.batches) validateRecords(batch.records);
  return journal;
}
