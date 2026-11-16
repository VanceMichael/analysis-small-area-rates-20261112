import test from 'node:test';
import assert from 'node:assert/strict';
import { posteriorSummary, probabilityBelow, rankAnalysis } from '../src/simulate.js';
import { betaIncomplete, betaInverse } from '../src/beta.js';
import { resolveStandardWeights, layerPooledPosterior, standardize } from '../src/standardize.js';

test('后验摘要的阈值概率与可信区间与精确分布一致', () => {
  const posterior = { status: 'estimated', alpha: 7, beta: 8 };
  const summary = posteriorSummary(posterior, 0.9);
  assert.ok(Math.abs(summary.mean - 7 / 15) < 1e-14);
  assert.ok(Math.abs(probabilityBelow(0.5, posterior) - betaIncomplete(0.5, 7, 8)) < 1e-14);
  assert.ok(Math.abs(summary.credible.lower - betaInverse(0.05, 7, 8)) < 1e-10);
  assert.ok(Math.abs(summary.credible.upper - betaInverse(0.95, 7, 8)) < 1e-10);
  const missing = posteriorSummary({ status: 'unavailable', reason: 'x' });
  assert.equal(missing.status, 'unavailable');
  assert.equal(probabilityBelow(0.5, { status: 'unavailable' }), null);
});

test('排序分析确定性可复现，名次分布与前 k 概率守恒', () => {
  const entries = [
    { point: 'a', alpha: 10, beta: 2 },
    { point: 'b', alpha: 4, beta: 4 },
    { point: 'c', alpha: 2, beta: 10 }
  ];
  const first = rankAnalysis(entries, { draws: 20000, seed: 99 });
  const second = rankAnalysis(entries, { draws: 20000, seed: 99 });
  assert.deepEqual(first.rankings.map(item => item.rankDistribution),
    second.rankings.map(item => item.rankDistribution));
  for (const item of first.rankings) {
    const rankSum = item.rankDistribution.reduce((sum, cell) => sum + cell.probability, 0);
    assert.ok(Math.abs(rankSum - 1) < 1e-12);
    assert.equal(item.topK.at(-1).probability, 1);
    for (const cell of item.rankDistribution) assert.ok(cell.standardError >= 0);
  }
  // a 后验最强，拿第一概率最高；c 最低
  const topOne = Object.fromEntries(first.rankings.map(item => [item.point, item.topK[0].probability]));
  assert.ok(topOne.a > topOne.b && topOne.b > topOne.c);
  // 成对矩阵反对称
  const beats = Object.fromEntries(first.pairwise.map(row => [row.point, Object.fromEntries(row.beats
    .filter(cell => cell.probability != null).map(cell => [cell.point, cell.probability]))]));
  assert.ok(Math.abs(beats.a.c + beats.c.a - 1) < 1e-12);
});

test('先验不可用点不参与排序但显式列出', () => {
  const result = rankAnalysis([
    { point: 'a', alpha: 3, beta: 3 },
    { point: 'z', alpha: null, beta: null, reason: '层先验不可用' }
  ], { draws: 5000, seed: 1 });
  assert.equal(result.rankings.length, 1);
  assert.deepEqual(result.unavailable, [{ point: 'z', reason: '层先验不可用' }]);
  assert.equal(rankAnalysis([{ point: 'z', alpha: null, beta: null }], { draws: 1000 }).rankings.length, 0);
});

test('固定权重校验：和为 1 且拒绝零/负权重，可用层为空时报错', () => {
  const weights = resolveStandardWeights(['a', 'b'], { a: 0.4, b: 0.6 });
  assert.deepEqual(weights, { a: 0.4, b: 0.6 });
  assert.throws(() => resolveStandardWeights(['a'], { a: 0.4, b: 0.7 }), /权重之和/);
  assert.throws(() => resolveStandardWeights(['a', 'b'], { c: 1 }), /没有任何/);
  assert.throws(() => resolveStandardWeights(['a'], { a: 0, b: 1 }), /必须是/);
  // 不可用层在可用层集合外：权重在可用层上重归一化（partial 场景）
  assert.deepEqual(resolveStandardWeights(['a'], { a: 0.4, b: 0.6 }), { a: 1 });
});

test('标准化率用固定权重，且不等于交易量加权粗率', () => {
  const priors = new Map([
    ['big', { layerKey: 'big', status: 'estimated', alpha: 2, beta: 8 }],   // 均值 0.2
    ['small', { layerKey: 'small', status: 'estimated', alpha: 8, beta: 2 }] // 均值 0.8
  ]);
  const posteriors = [
    layerPooledPosterior(priors.get('big'), { success: 20, attempts: 100 }),
    layerPooledPosterior(priors.get('small'), { success: 8, attempts: 10 })
  ];
  const result = standardize(posteriors, { big: 0.5, small: 0.5 }, { draws: 20000, seed: 5 });
  assert.equal(result.status, 'estimated');
  // 固定权重均值 = 0.5*0.2 + 0.5*0.8 = 0.5（解析矩，不依赖抽样）
  assert.ok(Math.abs(result.standardizedRate.mean - 0.5) < 1e-12);
  // 粗率按交易量：28/110 ≈ 0.255，与标准化率明显不同
  assert.ok(Math.abs(result.crudePooledRate - 28 / 110) < 1e-12);
  assert.notEqual(result.standardizedRate.mean, result.crudePooledRate);
  assert.deepEqual(result.volumeWeights, { big: 100 / 110, small: 10 / 110 });
});

test('先验不可用层使标准化降级为 partial 且权重重归一化', () => {
  const result = standardize([
    { layerKey: 'ok', status: 'estimated', alpha: 3, beta: 3, totals: { success: 5, attempts: 10 } },
    { layerKey: 'dead', status: 'unavailable', reason: '无训练', totals: { success: 0, attempts: 0 } }
  ], { ok: 0.7, dead: 0.3 }, { draws: 5000, seed: 6 });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.missingLayers.map(item => item.layerKey), ['dead']);
  assert.equal(result.weights.ok, 1);
});
