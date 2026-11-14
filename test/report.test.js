import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../src/report.js';
import { reconstructLedger } from '../src/ledger.js';
import { estimatePriors } from '../src/prior.js';
import { analyze } from '../src/model.js';

const policy = {
  trainThrough: 6, asOf: 10, threshold: 0.8, poolBy: ['region', 'service'],
  standardWeights: { north: 0.5, south: 0.5 },
};
const inc = (point, region, service, period, s, n, extra = {}) => ({
  point, region, service, period, successDelta: s, attemptsDelta: n, reset: false, ...extra,
});

function build(records) {
  const ledger = reconstructLedger(records, policy.asOf);
  const priors = estimatePriors(ledger.increments, { trainThrough: policy.trainThrough, poolBy: policy.poolBy });
  const analysis = analyze(ledger.increments, priors, policy, { seed: 1, draws: 500 });
  for (const point of analysis.points) {
    if (point.status === 'excluded_layer_without_prior' && !point.note) {
      point.note = '该层训练窗口无数据，未借用全局或其他层先验';
    }
  }
  return {
    asOf: policy.asOf, inputFingerprint: 'a'.repeat(64),
    ledger: { legalRecordCount: ledger.legal.length, supersededRecordIds: ledger.superseded,
      futureRecordIds: ledger.future, resets: ledger.resets, increments: ledger.increments },
    priors, analysis,
  };
}

const seed = {
  point: 'p0', region: 'north', service: 'card', period: 1,
  success: 1, attempts: 2, as_of: 2, revision: 1, reset: false, id: 'r0',
};
const row = (id, patch) => ({ ...seed, id, ...patch });

test('报告包含阈值概率、排序不确定性而不是均值排行榜', () => {
  const records = [
    row('r1', { point: 'small', period: 7, success: 2, attempts: 2 }),
    row('r2', { point: 'big', period: 1, success: 40, attempts: 50 }),
    row('r3', { point: 'big', period: 2, success: 80, attempts: 100, as_of: 3 }),
    row('r4', { point: 'weak', period: 1, success: 1, attempts: 10, region: 'south' }),
  ];
  const markdown = renderReport(build(records));
  assert.match(markdown, /资源复核清单/);
  assert.match(markdown, /P\(率<阈值\)/);
  assert.match(markdown, /后验名次/);
  assert.doesNotMatch(markdown, /按后验均值排名/);
  assert.match(markdown, /非排名榜/);
  assert.match(markdown, /固定业务结构/);
});

test('报告标记全成功、零尝试、重置与无先验层', () => {
  const records = [
    row('r1', { point: 'allwin', period: 7, success: 2, attempts: 2 }),
    row('r2', { point: 'quiet', period: 1, success: 0, attempts: 0 }),
    row('r3', { point: 'resetpt', period: 1, success: 3, attempts: 5 }),
    row('r4', { point: 'resetpt', period: 2, success: 2, attempts: 4, reset: true, as_of: 3 }),
    row('r5', { point: 'eastern', region: 'east', period: 7, success: 5, attempts: 8 }),
  ];
  const markdown = renderReport(build(records));
  assert.match(markdown, /全成功/);
  assert.match(markdown, /零尝试/);
  assert.match(markdown, /重置×1/);
  assert.match(markdown, /无层先验-排除/);
  assert.match(markdown, /未借用全局/);
});

test('小样本点仍出现在清单中', () => {
  const records = [row('r1', { point: 'tiny', period: 7, success: 1, attempts: 1 }),
    row('r2', { point: 'large', period: 1, success: 45, attempts: 60 })];
  const markdown = renderReport(build(records));
  assert.match(markdown, /tiny/);
  assert.match(markdown, /小样本/);
});
