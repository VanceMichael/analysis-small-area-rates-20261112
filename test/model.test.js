import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/model.js';
import { betaCdf } from '../src/beta.js';

const inc = (point, region, service, period, s, n) => ({
  point, region, service, period, successDelta: s, attemptsDelta: n, reset: false,
});
const layerKey = (region, service) => [region, service].join('\u0001');
const priors = entries => ({
  trainingWindow: { from: 1, through: 6 },
  poolBy: ['region', 'service'],
  layers: [],
  priorByLayer: Object.fromEntries(entries.map(([key, prior]) => [key, {
    mu: prior.alpha / (prior.alpha + prior.beta),
    k: prior.alpha + prior.beta,
    ...prior,
  }])),
});
const policy = {
  threshold: 0.8, poolBy: ['region', 'service'],
  standardWeights: { north: 0.5, south: 0.5 },
};

test('后验参数、阈值概率与可信区间按共轭公式给出', () => {
  const increments = [inc('a', 'north', 'card', 1, 2, 2), inc('a', 'north', 'card', 2, 1, 2)];
  const estimation = priors([[layerKey('north','card'), { alpha: 2, beta: 2 }]]);
  const result = analyze(increments, estimation, policy, { seed: 1, draws: 2000 });
  const point = result.points.find(item => item.point === 'a');
  assert.equal(point.posterior.alpha, 5);
  assert.equal(point.posterior.beta, 3);
  assert.ok(Math.abs(point.posterior.posteriorMean - 5 / 8) < 1e-14);
  const expectedProb = betaCdf(0.8, 5, 3);
  assert.ok(Math.abs(point.posterior.probabilityBelowThreshold - expectedProb) < 1e-12);
  assert.ok(point.posterior.credibleInterval.lower < point.posterior.posteriorMean
    && point.posterior.credibleInterval.upper > point.posterior.posteriorMean);
});

test('全成功小样本：原始率 100% 但后验均值小于 1、上界小于 1、夺冠不确定', () => {
  const increments = [
    inc('small', 'north', 'card', 7, 2, 2),
    inc('big1', 'north', 'card', 1, 40, 50), inc('big1', 'north', 'card', 2, 40, 50),
    inc('big2', 'north', 'card', 1, 42, 50), inc('big2', 'north', 'card', 2, 42, 50),
  ];
  const estimation = priors([[layerKey('north','card'), { alpha: 4, beta: 2 }]]);
  const result = analyze(increments, estimation, policy, { seed: 11, draws: 4000 });
  const small = result.points.find(item => item.point === 'small');
  assert.equal(small.rawRate, 1);
  assert.ok(small.posterior.posteriorMean < 1);
  assert.ok(small.posterior.credibleInterval.upper < 1);
  assert.ok(small.ranking.probabilityTop1 < 0.5, '两笔全成不应得到确定冠军');
  assert.ok(small.ranking.rankInterval95[1] > 1, '名次区间应反映不确定性');
});

test('零尝试点：无原始率，后验收缩为先验，仍保留在清单', () => {
  const increments = [inc('quiet', 'north', 'card', 1, 0, 0), inc('quiet', 'north', 'card', 2, 0, 0)];
  const estimation = priors([[layerKey('north','card'), { alpha: 3, beta: 7 }]]);
  const result = analyze(increments, estimation, policy, { seed: 2, draws: 500 });
  const point = result.points.find(item => item.point === 'quiet');
  assert.equal(point.rawRate, null);
  assert.equal(point.attempts, 0);
  assert.ok(Math.abs(point.posterior.posteriorMean - 0.3) < 1e-14);
  assert.equal(point.posterior.zeroAttempts, true);
});

test('无层先验的点被排除，不借全局先验，也不进入排序', () => {
  const increments = [
    inc('known', 'north', 'card', 1, 5, 10),
    inc('newlayer', 'east', 'card', 7, 5, 8),
  ];
  const estimation = priors([[layerKey('north','card'), { alpha: 2, beta: 2 }]]);
  const result = analyze(increments, estimation, policy, { seed: 3, draws: 500 });
  const missing = result.points.find(item => item.point === 'newlayer');
  assert.equal(missing.status, 'excluded_layer_without_prior');
  assert.equal(missing.posterior, null);
  assert.equal(missing.ranking, undefined);
  assert.equal(result.configuration.monteCarlo.rankedCount, 1);
});

test('标准化率按固定权重计算且不等于总体率，缺层不重新归一化', () => {
  const increments = [
    inc('a', 'north', 'card', 1, 6, 10),
    inc('b', 'south', 'card', 1, 9, 10),
  ];
  const estimation = priors([[layerKey('north','card'), { alpha: 1, beta: 1 }], [layerKey('south','card'), { alpha: 1, beta: 1 }]]);
  const result = analyze(increments, estimation, policy, { seed: 4, draws: 200 });
  const card = result.standardization.find(item => item.service === 'card');
  // 北层后验均值 7/12，南层 10/12，固定 0.5/0.5
  assert.ok(Math.abs(card.standardizedRate - (7 / 12 + 10 / 12) / 2) < 1e-12);
  // 总体率 = 15/20，与标准化口径不同
  assert.ok(Math.abs(card.crudePooledRate - 0.75) < 1e-12);
  assert.notEqual(card.standardizedRate, card.crudePooledRate);
  assert.ok(card.whyNotOverallRate.includes('固定业务结构'));
});

test('缺先验层时标准化保留固定权重并暴露覆盖缺口', () => {
  const increments = [inc('a', 'north', 'card', 1, 6, 10)];
  const estimation = priors([[layerKey('north','card'), { alpha: 1, beta: 1 }]]);
  const customPolicy = {
    threshold: 0.8, poolBy: ['region', 'service'],
    standardWeights: { north: 0.5, east: 0.5 },
  };
  const result = analyze(increments, estimation, customPolicy, { seed: 5, draws: 100 });
  const card = result.standardization.find(item => item.service === 'card');
  assert.equal(card.includedWeight, 0.5, 'east 层无先验，固定权重不重新归一化到北层');
  assert.ok(card.standardizedRate < 1);
  assert.equal(card.layers.find(layer => layer.region === 'east').included, false);
});

test('有先验但当前零观测的层按先验均值纳入标准化', () => {
  const increments = [inc('a', 'north', 'card', 1, 6, 10)];
  const estimation = priors([
    [layerKey('north','card'), { alpha: 1, beta: 1 }],
    [layerKey('south','card'), { alpha: 1, beta: 3 }],
  ]);
  const result = analyze(increments, estimation, policy, { seed: 7, draws: 100 });
  const card = result.standardization.find(item => item.service === 'card');
  assert.equal(card.includedWeight, 1);
  const south = card.layers.find(layer => layer.region === 'south');
  assert.ok(Math.abs(south.layerPosteriorMean - 0.25) < 1e-12);
});

test('分层字段跨期不一致直接报错', () => {
  const increments = [
    inc('a', 'north', 'card', 1, 1, 2),
    inc('a', 'south', 'card', 2, 1, 2),
  ];
  const estimation = priors([[layerKey('north','card'), { alpha: 1, beta: 1 }], [layerKey('south','card'), { alpha: 1, beta: 1 }]]);
  assert.throws(() => analyze(increments, estimation, policy, { seed: 6, draws: 100 }), /分层字段/);
});

test('排序结果在固定种子下可复现', () => {
  const increments = [
    inc('a', 'north', 'card', 1, 3, 10), inc('b', 'north', 'card', 1, 7, 10),
    inc('c', 'north', 'card', 1, 5, 10),
  ];
  const estimation = priors([[layerKey('north','card'), { alpha: 2, beta: 2 }]]);
  const first = analyze(increments, estimation, policy, { seed: 99, draws: 1000 });
  const second = analyze(increments, estimation, policy, { seed: 99, draws: 1000 });
  for (const point of first.points) {
    const other = second.points.find(item => item.point === point.point);
    assert.deepEqual(point.ranking, other.ranking);
  }
});
