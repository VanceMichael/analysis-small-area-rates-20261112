import test from 'node:test';
import assert from 'node:assert/strict';
import {
  logGamma, logBeta, betaIncomplete, betaInverse, betaMean, betaVariance,
  betaBinomialPmf, createRng, betaSample
} from '../src/beta.js';

test('logGamma 对已知参考值正确', () => {
  assert.ok(Math.abs(logGamma(1) - 0) < 1e-9);
  assert.ok(Math.abs(logGamma(0.5) - Math.log(Math.sqrt(Math.PI))) < 1e-9);
  assert.ok(Math.abs(Math.exp(logGamma(6)) - 120) < 1e-5);
  // logGamma(21/2) = log(654729075/131072 * sqrt(pi)) ≈ 13.940625217
  assert.ok(Math.abs(logGamma(10.5) - 13.940625217) < 1e-6);
});

test('正则化不完全 Beta 与对称/边界恒等式一致', () => {
  assert.equal(betaIncomplete(0, 2, 3), 0);
  assert.equal(betaIncomplete(1, 2, 3), 1);
  // I_x(a,b) + I_{1-x}(b,a) = 1
  for (const x of [0.1, 0.37, 0.5, 0.81]) {
    assert.ok(Math.abs(betaIncomplete(x, 2, 5) + betaIncomplete(1 - x, 5, 2) - 1) < 1e-9);
  }
  // a=b=1 即均匀分布
  assert.ok(Math.abs(betaIncomplete(0.42, 1, 1) - 0.42) < 1e-9);
  // Beta(2,3) CDF = 6x^2 - 8x^3 + 3x^4（密度 12x(1-x)^2 的积分）
  for (const x of [0.2, 0.55, 0.9]) {
    assert.ok(Math.abs(betaIncomplete(x, 2, 3) - (6 * x ** 2 - 8 * x ** 3 + 3 * x ** 4)) < 1e-9);
  }
});

test('逆不完全 Beta 与 CDF 互逆', () => {
  for (const [a, b] of [[2, 3], [5, 5], [0.5, 7], [100, 200]]) {
    for (const p of [0.05, 0.5, 0.95]) {
      const x = betaInverse(p, a, b);
      assert.ok(Math.abs(betaIncomplete(x, a, b) - p) < 1e-8, `a=${a} b=${b} p=${p}`);
    }
  }
  assert.equal(betaInverse(0, 2, 2), 0);
  assert.equal(betaInverse(1, 2, 2), 1);
});

test('Beta 均值方差解析值正确', () => {
  assert.ok(Math.abs(betaMean(3, 7) - 0.3) < 1e-14);
  assert.ok(Math.abs(betaVariance(3, 7) - (3 * 7) / (100 * 11)) < 1e-14);
});

test('Beta-Binomial 质量函数归一且与 Beta(1,1) 二项一致', () => {
  const n = 8;
  let total = 0;
  for (let k = 0; k <= n; k += 1) total += betaBinomialPmf(k, n, 1, 1);
  assert.ok(Math.abs(total - 1) < 1e-8);
  // Beta(1,1) 退化为均匀先验，边际为 1/(n+1)
  assert.ok(Math.abs(betaBinomialPmf(3, n, 1, 1) - 1 / (n + 1)) < 1e-9);
  // logBeta 自洽
  assert.ok(Math.abs(Math.exp(logBeta(2, 3)) - 1 / 12) < 1e-9);
});

test('确定性随机流可复现，Beta 抽样矩接近解析矩', () => {
  const first = createRng(7);
  const second = createRng(7);
  for (let i = 0; i < 1000; i += 1) assert.equal(first(), second());
  const rng = createRng(123);
  const draws = 60000;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < draws; i += 1) {
    const x = betaSample(rng, 4, 6);
    sum += x;
    sumSq += x * x;
  }
  const empiricalMean = sum / draws;
  const empiricalVariance = sumSq / draws - empiricalMean ** 2;
  assert.ok(Math.abs(empiricalMean - betaMean(4, 6)) < 0.01);
  assert.ok(Math.abs(empiricalVariance - betaVariance(4, 6)) < 0.005);
});
