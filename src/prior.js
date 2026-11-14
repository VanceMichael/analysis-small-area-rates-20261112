// 分层 Beta-Binomial 经验贝叶斯：先验只在指定训练窗口内、按 poolBy 定义的层估计。
// 参数化 mu=alpha/(alpha+beta)、k=alpha+beta；坐标上升 + 黄金分割做极大似然，
// 矩估计提供初值。边界解、单层一点与过度离散诊断全部显式输出，不回退到全局先验。

import { logBeta, logGamma } from './beta.js';

export const K_MIN = 1e-3;
export const K_MAX = 1e6;
const MU_FLOOR = 1e-6;
const FALLBACK_CONCENTRATION = 2;
// 单点全成功/全失败时，经验均值落在 Beta 支撑边界；夹到 0.05/0.95 保留弱但非退化的正则先验。
const DEGENERATE_RATE_MARGIN = 0.05;

function binomialConstant(success, attempts) {
  return logGamma(attempts + 1) - logGamma(success + 1) - logGamma(attempts - success + 1);
}

// Beta-Binomial 对数似然（含组合常数，跨模型差值不受常数影响）。
export function betaBinomialLogLik(rows, mu, k) {
  if (!(mu > 0 && mu < 1) || !(k > 0)) return -Infinity;
  const alpha = mu * k;
  const beta = k - alpha;
  let total = 0;
  for (const { successDelta: s, attemptsDelta: n } of rows) {
    total += binomialConstant(s, n)
      + logBeta(s + alpha, n - s + beta) - logBeta(alpha, beta);
  }
  return total;
}

function binomialLogLik(rows, mu) {
  let total = 0;
  for (const { successDelta: s, attemptsDelta: n } of rows) {
    total += binomialConstant(s, n) + s * Math.log(mu) + (n - s) * Math.log(1 - mu);
  }
  return total;
}

function goldenSectionMinimize(fn, low, high, iterations = 80) {
  const phi = (Math.sqrt(5) + 1) / 2;
  const residue = 2 - phi;
  let left = low + residue * (high - low);
  let right = high - residue * (high - low);
  let fLeft = fn(left);
  let fRight = fn(right);
  for (let i = 0; i < iterations; i += 1) {
    if (fLeft <= fRight) {
      high = right;
      right = left;
      fRight = fLeft;
      left = low + residue * (high - low);
      fLeft = fn(left);
    } else {
      low = left;
      left = right;
      fLeft = fRight;
      right = high - residue * (high - low);
      fRight = fn(right);
    }
    if (high - low < 1e-12) break;
  }
  const midpoint = (low + high) / 2;
  return { value: midpoint, objective: fn(midpoint) };
}

// 矩估计初值：加权经验方差扣除二项抽样方差后，反解 Beta 浓度。
function methodOfMoments(rows) {
  const totalAttempts = rows.reduce((sum, row) => sum + row.attemptsDelta, 0);
  const totalSuccess = rows.reduce((sum, row) => sum + row.successDelta, 0);
  const mu = totalSuccess / totalAttempts;
  let empiricalVariance = 0;
  let binomialVariance = 0;
  for (const row of rows) {
    const weight = row.attemptsDelta / totalAttempts;
    const rate = row.successDelta / row.attemptsDelta;
    empiricalVariance += weight * (rate - mu) ** 2;
    binomialVariance += weight * (mu * (1 - mu)) / row.attemptsDelta;
  }
  const betweenVariance = empiricalVariance - binomialVariance;
  let k;
  let varianceAtBoundary = false;
  if (betweenVariance <= 0) {
    k = K_MAX;
    varianceAtBoundary = true;
  } else {
    k = (mu * (1 - mu)) / betweenVariance - 1;
    k = Math.min(K_MAX, Math.max(K_MIN, k));
  }
  return { mu, k, empiricalVariance, binomialVariance, varianceAtBoundary };
}

function fitMaximumLikelihood(rows, startMu, startK) {
  let mu = Math.min(1 - MU_FLOOR, Math.max(MU_FLOOR, startMu));
  let k = Math.min(K_MAX, Math.max(K_MIN, startK));
  let logLik = betaBinomialLogLik(rows, mu, k);
  let converged = false;
  let iterations = 0;
  for (iterations = 1; iterations <= 60; iterations += 1) {
    const previousMu = mu;
    const previousK = k;
    const muStep = goldenSectionMinimize(candidate => -betaBinomialLogLik(rows, candidate, k),
      MU_FLOOR, 1 - MU_FLOOR);
    mu = muStep.value;
    const kStep = goldenSectionMinimize(logCandidate => -betaBinomialLogLik(rows, mu, Math.exp(logCandidate)),
      Math.log(K_MIN), Math.log(K_MAX));
    k = Math.exp(kStep.value);
    logLik = -kStep.objective;
    if (Math.abs(mu - previousMu) < 1e-10 && Math.abs(Math.log(k / previousK)) < 1e-10) {
      converged = true;
      break;
    }
  }
  return { mu, k, logLik, converged, iterations };
}

// 估计单个层。rows 必须只含 attemptsDelta > 0 的训练期增量。
export function fitLayerPrior(rows, layerKey, dimensions) {
  const observed = rows.filter(row => row.attemptsDelta > 0);
  const base = {
    layerKey,
    dimensions,
    estimationTarget: {
      model: 'Beta-Binomial',
      parameterization: { mu: 'alpha/(alpha+beta)', k: 'alpha+beta' },
      trainingRows: observed.length,
      totalAttempts: observed.reduce((sum, row) => sum + row.attemptsDelta, 0),
      totalSuccess: observed.reduce((sum, row) => sum + row.successDelta, 0),
    },
  };
  if (observed.length === 0) {
    // 一层没有数据：显式标记，禁止上层分析偷偷借用全局先验。
    return {
      ...base,
      status: 'no_training_data',
      estimable: false,
      boundary: ['layer_without_training_observations'],
      prior: null,
      overdispersion: null,
    };
  }
  const moments = methodOfMoments(observed);
  if (observed.length === 1) {
    // 单层仅一点：mu 可识别，浓度 k 不可识别；记录理由并使用显式保守浓度。
    const only = observed[0];
    const rawMu = only.successDelta / only.attemptsDelta;
    // Beta 支撑是开区间 (0,1)：全成功/全失败的经验均值夹到弱正则位置，避免先验参数退化为 0。
    const mu = Math.min(1 - DEGENERATE_RATE_MARGIN, Math.max(DEGENERATE_RATE_MARGIN, rawMu));
    const k = FALLBACK_CONCENTRATION;
    const boundary = ['dispersion_unidentifiable_single_observation'];
    if (rawMu <= 0 || rawMu >= 1) boundary.push('mean_clamped_from_degenerate_rate');
    return {
      ...base,
      status: 'single_observation_dispersion_unidentified',
      estimable: true,
      boundary,
      moments: {
        mu: moments.mu,
        empiricalVariance: moments.empiricalVariance,
        binomialVariance: moments.binomialVariance,
        varianceAtBoundary: moments.varianceAtBoundary,
      },
      prior: {
        mu,
        k,
        alpha: mu * k,
        beta: (1 - mu) * k,
        concentrationChoice: `single observation: dispersion not identifiable, explicit fallback k=${k}`,
      },
      logLik: betaBinomialLogLik(observed, mu, k),
      overdispersion: overdispersionDiagnostics(observed, mu, k, moments),
    };
  }
  const fit = fitMaximumLikelihood(observed, moments.mu, moments.k);
  const boundary = [];
  if (fit.mu <= MU_FLOOR * 10) boundary.push('mean_at_lower_bound');
  if (fit.mu >= 1 - MU_FLOOR * 10) boundary.push('mean_at_upper_bound');
  if (fit.k >= K_MAX * (1 - 1e-4)) boundary.push('concentration_at_upper_bound');
  if (fit.k <= K_MIN * 10) boundary.push('concentration_at_lower_bound');
  if (moments.varianceAtBoundary) boundary.push('moments_between_variance_non_positive');
  return {
    ...base,
    status: boundary.length ? 'maximum_likelihood_boundary_solution' : 'maximum_likelihood_interior_solution',
    estimable: true,
    boundary,
    converged: fit.converged,
    iterations: fit.iterations,
    moments: {
      mu: moments.mu,
      k: moments.k,
      empiricalVariance: moments.empiricalVariance,
      binomialVariance: moments.binomialVariance,
      varianceAtBoundary: moments.varianceAtBoundary,
    },
    prior: { mu: fit.mu, k: fit.k, alpha: fit.mu * fit.k, beta: (1 - fit.mu) * fit.k },
    logLik: fit.logLik,
    overdispersion: overdispersionDiagnostics(observed, fit.mu, fit.k, moments),
  };
}

function overdispersionDiagnostics(rows, mu, k, moments) {
  const binomialMu = rows.reduce((sum, row) => sum + row.successDelta, 0)
    / rows.reduce((sum, row) => sum + row.attemptsDelta, 0);
  const binomialFit = binomialLogLik(rows, Math.min(1 - MU_FLOOR, Math.max(MU_FLOOR, binomialMu)));
  const betaBinomialFit = betaBinomialLogLik(rows, mu, k);
  return {
    intraclassCorrelation: 1 / (k + 1),
    empiricalWeightedVariance: moments.empiricalVariance,
    binomialSamplingVariance: moments.binomialVariance,
    varianceRatio: moments.empiricalVariance / Math.max(moments.binomialVariance, Number.MIN_VALUE),
    logLikBetaBinomial: betaBinomialFit,
    logLikBinomial: binomialFit,
    logLikImprovement: betaBinomialFit - binomialFit,
  };
}

export function layerKeyOf(record, poolBy) {
  return poolBy.map(field => record[field]).join('\u0001');
}

// 用训练窗口内的增量逐层估计先验；没有训练数据的层保留 null 先验并说明原因。
export function estimatePriors(increments, { trainThrough, trainFrom = 1, poolBy }) {
  const layers = new Map();
  for (const row of increments) {
    if (row.period < trainFrom || row.period > trainThrough) continue;
    const key = layerKeyOf(row, poolBy);
    if (!layers.has(key)) {
      layers.set(key, { rows: [], dimensions: Object.fromEntries(poolBy.map(field => [field, row[field]])) });
    }
    layers.get(key).rows.push(row);
  }
  const results = [...layers.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([key, { rows, dimensions }]) => fitLayerPrior(rows, key, dimensions));
  const priorByLayer = Object.fromEntries(results.map(result => [result.layerKey, result.prior]));
  return {
    trainingWindow: { from: trainFrom, through: trainThrough },
    poolBy,
    layers: results,
    priorByLayer,
  };
}
