import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logGamma, logBeta, betaCdf, betaQuantile, betaMean, betaVariance,
  conjugateUpdate, createRng, betaSample,
} from '../src/beta.js';

test('logGamma 对照已知精确值', () => {
  assert.ok(Math.abs(logGamma(1) - 0) < 1e-12);
  assert.ok(Math.abs(logGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-12);
  assert.ok(Math.abs(logGamma(6) - Math.log(120)) < 1e-12);
  assert.ok(Math.abs(logGamma(10) - Math.log(362880)) < 1e-10);
});

test('betaCdf 对照对称性与已知分布值', () => {
  assert.equal(betaCdf(0, 1, 1), 0);
  assert.equal(betaCdf(1, 1, 1), 1);
  assert.ok(Math.abs(betaCdf(0.5, 1, 1) - 0.5) < 1e-12);
  // Beta(2,1) CDF = x^2
  assert.ok(Math.abs(betaCdf(0.3, 2, 1) - 0.09) < 1e-10);
  // Beta(1,2) CDF = 1-(1-x)^2
  assert.ok(Math.abs(betaCdf(0.3, 1, 2) - (1 - 0.7 ** 2)) < 1e-10);
  // 对称 Beta(2,2) 中位数为 0.5
  assert.ok(Math.abs(betaCdf(0.5, 2, 2) - 0.5) < 1e-10);
  // 对称分布 CDF 互补
  assert.ok(Math.abs(betaCdf(0.3, 3, 3) + betaCdf(0.7, 3, 3) - 1) < 1e-10);
  assert.ok(!Number.isNaN(betaCdf(0.5, 1000000, 1000000)));
});

test('betaQuantile 是 betaCdf 的逆，且边界参数稳定', () => {
  for (const [a, b, p] of [[2, 5, 0.025], [2, 5, 0.975], [0.1, 0.1, 0.5], [100, 2, 0.3], [1, 1, 0.7]]) {
    const q = betaQuantile(p, a, b);
    assert.ok(Math.abs(betaCdf(q, a, b) - p) < 1e-6, `a=${a} b=${b} p=${p}`);
  }
  // 全成功场景 Beta(a+n, b) 极偏分布也能求分位数且不越界
  const q = betaQuantile(0.025, 102, 1);
  assert.ok(q > 0.9 && q < 1);
});

test('矩与共轭更新公式', () => {
  assert.ok(Math.abs(betaMean(3, 2) - 0.6) < 1e-14);
  assert.ok(Math.abs(betaVariance(3, 2) - (0.6 * 0.4 / 6)) < 1e-14);
  const updated = conjugateUpdate(2, 3, 8, 10);
  assert.deepEqual(updated, { alpha: 10, beta: 5 });
  assert.throws(() => conjugateUpdate(1, 1, 5, 3), /success <= attempts/);
  assert.throws(() => conjugateUpdate(1, 1, -1, 2), /安全整数|0 <=/);
});

test('共轭后验收缩手算核对：小样本点向层均值收缩', () => {
  // 先验 Beta(2,2) 均值 0.5；观测 2 成功/2 尝试（全成功小样本）
  const posterior = conjugateUpdate(2, 2, 2, 2);
  assert.deepEqual(posterior, { alpha: 4, beta: 2 });
  const mean = betaMean(posterior.alpha, posterior.beta);
  assert.ok(mean < 1, '全成功小样本后验均值必须小于 1');
  assert.ok(Math.abs(mean - 4 / 6) < 1e-14);
  // 阈值 0.8 以下的后验概率 = I_0.8(4,2) = x^4(5-4x)
  const manual = 0.8 ** 4 * (5 - 4 * 0.8);
  assert.ok(Math.abs(betaCdf(0.8, 4, 2) - manual) < 1e-10);
  // 可信区间上界严格小于 1，不给出确定冠军
  assert.ok(betaQuantile(0.975, 4, 2) < 1);
});

test('确定性随机流可复现，Beta 抽样矩收敛', () => {
  const a = createRng(42);
  const b = createRng(42);
  assert.equal(a(), b());
  const rng = createRng(7);
  const draws = Array.from({ length: 200000 }, () => betaSample(rng, 3, 2));
  const empiricalMean = draws.reduce((sum, value) => sum + value, 0) / draws.length;
  assert.ok(Math.abs(empiricalMean - 0.6) < 0.01);
});

test('logBeta 与组合似然所需恒等式', () => {
  assert.ok(Math.abs(logBeta(1, 1) - 0) < 1e-12);
  assert.ok(Math.abs(logBeta(2, 3) - (logGamma(2) + logGamma(3) - logGamma(5))) < 1e-12);
});
