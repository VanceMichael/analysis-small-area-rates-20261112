import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeJournal, addBatch, withdrawBatch,
  saveJournal, loadJournal, activeRecords
} from '../src/journal.js';
import { loadPolicy, resolveLayerWeights } from '../src/policy.js';
import { fingerprint } from '../src/dataset.js';

const policy = loadPolicy(JSON.parse(await readFile('data/case-policy.json', 'utf8')));
const cases = JSON.parse(await readFile('data/case-records.json', 'utf8')).records;

function period9Records() {
  return ['X', 'Y'].map((point, index) => ({
    id: `b-${point}`, point, region: 'north', service: 'card',
    period: 9, success: index + 1, attempts: index + 4, as_of: 12, revision: 1, reset: false
  }));
}

test('日志初始化封存训练窗口并记录输入指纹', () => {
  const journal = initializeJournal({ inputRecords: cases, policy });
  assert.equal(journal.spec.trainThrough, 6);
  assert.equal(journal.batches.length, 0);
  assert.equal(journal.baseFingerprint, fingerprint(cases));
});

test('训练窗口之后到达的训练期记录拒绝进入批次', () => {
  const journal = initializeJournal({ inputRecords: cases, policy });
  const late = [{ ...cases[0], id: 'late1', period: 6, as_of: 12, revision: 3 }];
  assert.throws(() => addBatch(journal, 'b1', late), /训练窗口已封存/);
  assert.throws(() => initializeJournal({
    inputRecords: [...cases, ...late], policy
  }), /训练窗口无法封存/);
});

test('同一批次只接受一次，重复指纹也被拒绝', () => {
  const journal = initializeJournal({ inputRecords: cases, policy });
  addBatch(journal, 'b1', period9Records());
  assert.throws(() => addBatch(journal, 'b1', period9Records()), /只能更新一次/);
  assert.throws(() => addBatch(journal, 'b2', period9Records()), /禁止重复更新/);
  assert.equal(activeRecords(journal).length, cases.length + 2);
});

test('撤回批次可重建后验：撤回痕迹保留，重放不含撤回数据', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'journal-'));
  try {
    const path = join(folder, 'journal.json');
    const journal = initializeJournal({ inputRecords: cases, policy });
    addBatch(journal, 'b1', period9Records());
    const withBatch = activeRecords(journal);
    await saveJournal(path, journal);
    const reloaded = await loadJournal(path);
    assert.equal(activeRecords(reloaded).length, withBatch.length);
    withdrawBatch(reloaded, 'b1');
    await saveJournal(path, reloaded);
    const afterWithdrawal = await loadJournal(path);
    assert.equal(activeRecords(afterWithdrawal).length, cases.length);
    assert.deepEqual(afterWithdrawal.withdrawnBatches.map(item => item.batchId), ['b1']);
    // 撤回后同号批次不可再用，必须换新号
    assert.throws(() => addBatch(afterWithdrawal, 'b1', period9Records()), /已撤回/);
    addBatch(afterWithdrawal, 'b1-redo', period9Records());
    assert.equal(activeRecords(afterWithdrawal).length, cases.length + 2);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('策略校验覆盖版本、阈值、权重和决策概率', () => {
  assert.throws(() => loadPolicy({ ...policy, version: 1 }), /版本/);
  assert.throws(() => loadPolicy({ ...policy, threshold: 1.2 }), /threshold/);
  assert.throws(() => loadPolicy({ ...policy, asOf: 1 }), /asOf/);
  const badReview = { ...policy, review: { ...policy.review, actionProbability: 0.4 } };
  assert.throws(() => loadPolicy(badReview), /actionProbability/);
  const noWeights = { ...policy, layerWeights: undefined, standardWeights: undefined };
  assert.throws(() => loadPolicy(noWeights), /layerWeights/);
});

test('region 权重在层维度按 service 等权展开', async () => {
  const regionPolicy = loadPolicy(JSON.parse(await readFile('data/policy.json', 'utf8')));
  const weights = resolveLayerWeights(regionPolicy, ['north/card', 'north/language', 'south/card', 'south/language']);
  assert.deepEqual(weights, {
    'north/card': 0.25, 'north/language': 0.25,
    'south/card': 0.25, 'south/language': 0.25
  });
  const layerPolicy = loadPolicy(JSON.parse(await readFile('data/case-policy.json', 'utf8')));
  assert.equal(resolveLayerWeights(layerPolicy, ['north/card'])['north/card'], 0.3);
});

test('落盘日志是规范 JSON 且可在空目录重建', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'journal-io-'));
  try {
    const path = join(folder, 'nested', 'journal.json');
    const journal = initializeJournal({ inputRecords: cases, policy });
    await saveJournal(path, journal);
    const reloaded = await loadJournal(path);
    assert.equal(reloaded.version, 1);
    assert.ok((await readFile(path, 'utf8')).includes('"snapshotFingerprint"'));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
