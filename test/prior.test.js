import test from 'node:test';
import assert from 'node:assert/strict';
import { fitLayerPrior, estimatePriors, betaBinomialLogLik, K_MAX } from '../src/prior.js';

const inc = (point, period, successDelta, attemptsDelta, extra = {}) => ({
  point, region: 'north', service: 'card', period,
  successDelta, attemptsDelta, reset: false, ...extra,
});

test('异质层 MLE 落内部解，浓度有限且似然不低于矩估计', () => {
  const rows = [
    inc('a', 1, 1, 10), inc('b', 1, 9, 10), inc('c', 1, 2, 10),
    inc('d', 1, 8, 10), inc('e', 1, 5, 10), inc('f', 1, 1, 10),
  ];
  const result = fitLayerPrior(rows, 'northcard', { region: 'north', service: 'card' });
  assert.equal(result.status, 'maximum_likelihood_interior_solution');
  assert.deepEqual(result.boundary, []);
  assert.ok(result.prior.k > 1 && result.prior.k < K_MAX);
  assert.ok(result.prior.mu > 0 && result.prior.mu < 1);
  assert.ok(result.overdispersion.varianceRatio > 1, '过度离散层方差比应大于 1');
  assert.ok(result.overdispersion.logLikImprovement > 0, 'Beta-Binomial 应优于二项拟合');
  const momentsLik = betaBinomialLogLik(rows, result.moments.mu, result.moments.k);
  assert.ok(result.logLik >= momentsLik - 1e-8);
});

test('同质层给出上边界解并显式记录边界与诊断', () => {
  const rows = [inc('a', 1, 5, 10), inc('b', 1, 5, 10), inc('c', 1, 5, 10)];
  const result = fitLayerPrior(rows, 'h', {});
  assert.equal(result.status, 'maximum_likelihood_boundary_solution');
  assert.ok(result.boundary.some(flag => flag.includes('upper_bound') || flag.includes('non_positive')));
  assert.ok(result.prior.k >= K_MAX * 0.99, `浓度应贴近上界，实际 k=${result.prior.k}`);
  // 有限浓度下 Beta-Binomial 略劣于（退化为）二项，似然提升应接近零且不显著为正
  assert.ok(result.overdispersion.logLikImprovement <= 1e-3);
});

test('层内仅一点：浓度不可识别，显式保守浓度而非全局借用', () => {
  const result = fitLayerPrior([inc('a', 1, 3, 4)], 'solo', {});
  assert.equal(result.status, 'single_observation_dispersion_unidentified');
  assert.ok(result.boundary.includes('dispersion_unidentifiable_single_observation'));
  assert.equal(result.prior.mu, 0.75);
  assert.equal(result.prior.k, 2);
  assert.ok(result.prior.concentrationChoice.includes('not identifiable'));
});

test('层内仅一点且全成功/全失败：均值夹到弱正则位置，先验参数严格为正', () => {
  const allSuccess = fitLayerPrior([inc('a', 1, 5, 5)], 'win', {});
  assert.ok(allSuccess.prior.mu > 0 && allSuccess.prior.mu < 1);
  assert.equal(allSuccess.prior.mu, 0.95);
  assert.ok(allSuccess.prior.alpha > 1 && allSuccess.prior.beta > 0);
  assert.ok(allSuccess.boundary.includes('mean_clamped_from_degenerate_rate'));
  const allFail = fitLayerPrior([inc('b', 1, 0, 5)], 'lose', {});
  assert.equal(allFail.prior.mu, 0.05);
  assert.ok(allFail.prior.alpha > 0 && allFail.prior.beta > 1);
});

test('训练窗无数据：返回 null 先验且禁止借用', () => {
  const result = fitLayerPrior([], 'empty', {});
  assert.equal(result.status, 'no_training_data');
  assert.equal(result.estimable, false);
  assert.equal(result.prior, null);
  assert.ok(result.boundary.includes('layer_without_training_observations'));
});

test('先验只由训练窗口数据估计，窗外观测不进入超参数', () => {
  const rows = [
    inc('a', 1, 1, 10), inc('b', 1, 9, 10), inc('c', 1, 2, 10),
    inc('a', 7, 10, 10), inc('b', 7, 10, 10), // 窗外高成功率，不应影响 mu
  ];
  const estimation = estimatePriors(rows, { trainThrough: 6, poolBy: ['region', 'service'] });
  const layer = estimation.layers[0];
  assert.equal(layer.estimationTarget.trainingRows, 3);
  assert.ok(layer.prior.mu < 0.6, '训练窗 mu 较低；若混入窗外高成功率会接近 0.9');
  assert.deepEqual(estimation.trainingWindow, { from: 1, through: 6 });
});

test('不同层独立估计，层键互不串用', () => {
  const rows = [
    inc('a', 1, 1, 10), inc('b', 1, 2, 10),
    { ...inc('c', 1, 9, 10), region: 'south' }, { ...inc('d', 1, 8, 10), region: 'south' },
  ];
  const estimation = estimatePriors(rows, { trainThrough: 6, poolBy: ['region', 'service'] });
  const keys = estimation.layers.map(layer => layer.layerKey).sort();
  const northKey = ['north', 'card'].join('\u0001');
  const southKey = ['south', 'card'].join('\u0001');
  assert.ok(keys.includes(northKey) && keys.includes(southKey));
  const north = estimation.priorByLayer[northKey];
  const south = estimation.priorByLayer[southKey];
  assert.ok(south.mu > north.mu);
});

test('零尝试增量不参与先验估计目标计数', () => {
  const rows = [inc('a', 1, 0, 0), inc('b', 1, 4, 8), inc('c', 1, 2, 8)];
  const result = fitLayerPrior(rows, 'z', {});
  assert.equal(result.estimationTarget.trainingRows, 2);
  assert.equal(result.estimationTarget.totalAttempts, 16);
});
