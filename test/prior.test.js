import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { estimateLayerPrior, updatePosterior } from '../src/prior.js';
import { betaIncomplete } from '../src/beta.js';

const limits = { minConcentration: 1, maxConcentration: 10000 };

test('矩估计与手算结果一致（两点等样本量）', () => {
  // n1=n2=10, y1=8, y2=2 => μ=0.5, R = (10*0.09+10*0.09)/20 = 0.09
  const prior = estimateLayerPrior('L', [
    { point: 'a', y: 8, n: 10, rate: 0.8 },
    { point: 'b', y: 2, n: 10, rate: 0.2 }
  ], limits);
  assert.equal(prior.status, 'estimated');
  assert.ok(Math.abs(prior.pooledRateRaw - 0.5) < 1e-14);
  // 等样本量公式 M = (μ(1-μ)-R)/(R-μ(1-μ)/k) = (0.25-0.09)/(0.09-0.125)...
  // 通用公式：k=2,N=20 => M = N*(v-R)/(R*N-k*v), v=0.25
  const expectedM = (20 * (0.25 - 0.09)) / (0.09 * 20 - 2 * 0.25);
  assert.ok(Math.abs(prior.concentration - expectedM) < 1e-12);
  assert.ok(Math.abs(prior.alpha - 0.5 * expectedM) < 1e-12);
  assert.ok(Math.abs(prior.beta - 0.5 * expectedM) < 1e-12);
  assert.ok(Math.abs(prior.intraClassCorrelation - 1 / (expectedM + 1)) < 1e-14);
  assert.deepEqual(prior.flags, []);
});

test('无训练数据层标记 unavailable 且不产出全局先验', () => {
  const prior = estimateLayerPrior('empty', [], limits);
  assert.equal(prior.status, 'unavailable');
  assert.deepEqual(prior.flags, ['noTrainingData']);
  assert.equal(prior.alpha, undefined);
  const zero = estimateLayerPrior('zero', [{ point: 'z', y: 0, n: 0, rate: null }], limits);
  assert.equal(zero.status, 'unavailable');
  // 后验同样保持 unavailable，不偷偷借用
  const posterior = updatePosterior(zero, 2, 2);
  assert.equal(posterior.status, 'unavailable');
  assert.equal(posterior.alpha, null);
});

test('层内仅一点：集中参数不可识别并标记上边界', () => {
  const prior = estimateLayerPrior('single', [{ point: 'a', y: 6, n: 10, rate: 0.6 }], limits);
  assert.equal(prior.status, 'estimated');
  assert.equal(prior.concentration, 10000);
  assert.ok(prior.flags.includes('singlePointConcentrationUnidentified'));
  assert.ok(prior.flags.includes('concentrationAtMax'));
});

test('全成功/全失败的均值边界走加 2 平滑并保留原始率', () => {
  const allSuccess = estimateLayerPrior('all', [
    { point: 'a', y: 10, n: 10, rate: 1 },
    { point: 'b', y: 8, n: 8, rate: 1 }
  ], limits);
  assert.equal(allSuccess.pooledRateRaw, 1);
  assert.ok(Math.abs(allSuccess.pooledRateAdjusted - 19 / 20) < 1e-14);
  assert.ok(allSuccess.flags.includes('meanBoundary'));
  assert.ok(allSuccess.alpha > 0 && allSuccess.beta > 0);
  const allFail = estimateLayerPrior('fail', [
    { point: 'a', y: 0, n: 5, rate: 0 },
    { point: 'b', y: 0, n: 7, rate: 0 }
  ], limits);
  assert.equal(allFail.pooledRateRaw, 0);
  assert.ok(Math.abs(allFail.pooledRateAdjusted - 1 / 14) < 1e-14);
});

test('过度离散达到上限时集中参数落在最小边界', () => {
  // 两点率 1 与 0，R = μ(1-μ)（最大可能值）
  const prior = estimateLayerPrior('polar', [
    { point: 'a', y: 10, n: 10, rate: 1 },
    { point: 'b', y: 0, n: 10, rate: 0 }
  ], limits);
  // μ=0.5 不触均值边界，R=0.25=μ(1-μ) => 最大过度离散边界
  assert.ok(prior.flags.includes('maxOverdispersionBoundary'));
  assert.equal(prior.concentration, 1);
});

test('观测不到过度离散（点率一致）时集中参数落在最大边界', () => {
  const prior = estimateLayerPrior('tight', [
    { point: 'a', y: 5, n: 10, rate: 0.5 },
    { point: 'b', y: 10, n: 20, rate: 0.5 },
    { point: 'c', y: 15, n: 30, rate: 0.5 }
  ], limits);
  assert.equal(prior.weightedRateVariance, 0);
  assert.ok(prior.flags.includes('noDetectableOverdispersion'));
  assert.equal(prior.concentration, 10000);
  assert.ok(prior.intraClassCorrelation < 1e-3);
});

test('矩估计在非等样本量下满足 Beta-Binomial 方差恒等式', () => {
  const points = [
    { point: 'a', y: 7, n: 10, rate: 0.7 },
    { point: 'b', y: 12, n: 30, rate: 0.4 },
    { point: 'c', y: 40, n: 50, rate: 0.8 }
  ];
  const prior = estimateLayerPrior('mixed', points, limits);
  const N = points.reduce((sum, item) => sum + item.n, 0);
  const k = points.length;
  const mu = prior.pooledRateRaw;
  const expectedR = mu * (1 - mu) * (k * prior.concentration + N) / (N * (prior.concentration + 1));
  assert.ok(Math.abs(expectedR - prior.weightedRateVariance) < 1e-10);
  // 过度离散因子 >= 1（Beta-Binomial 相对二项的方差膨胀）
  assert.ok(prior.overdispersionFactor >= 1);
});

test('共轭后验等于先验参数加计数，且阈值概率可用精确 CDF 复核', () => {
  const prior = { status: 'estimated', alpha: 2, beta: 3 };
  const posterior = updatePosterior(prior, 5, 10);
  assert.deepEqual([posterior.alpha, posterior.beta], [7, 8]);
  // 手算：alpha=2+5, beta=3+(10-5)
  assert.equal(posterior.priorAlpha, 2);
  assert.equal(posterior.addedSuccess, 5);
  assert.equal(posterior.addedAttempts, 10);
  // 零尝试只复制先验
  const idle = updatePosterior(prior, 0, 0);
  assert.deepEqual([idle.alpha, idle.beta], [2, 3]);
  // 精确 CDF：P(theta<0.5) under Beta(7,8)
  const p = betaIncomplete(0.5, 7, 8);
  assert.ok(p > 0.5 && p < 0.95);
  assert.throws(() => updatePosterior(prior, 9, 8), /不合法/);
});

test('演练数据各层先验估计稳定可复现', async () => {
  const cases = JSON.parse(await readFile('data/case-records.json', 'utf8')).records;
  const { reconstructLedger, splitWindow } = await import('../src/ledger.js');
  const ledger = reconstructLedger(cases, 10);
  const byLayer = new Map();
  for (const item of ledger.points) {
    const windows = splitWindow(item, 6);
    if (!byLayer.has(item.layerKey)) byLayer.set(item.layerKey, []);
    byLayer.get(item.layerKey).push({ point: item.point, ...windows.training });
  }
  const southCard = estimateLayerPrior('south/card', byLayer.get('south/card'), limits);
  // 该层训练期只有 C 一个有效点（N 无训练窗口）
  assert.ok(southCard.flags.includes('singlePointConcentrationUnidentified'));
  assert.deepEqual([...southCard.contributingPoints], ['C']);
});
