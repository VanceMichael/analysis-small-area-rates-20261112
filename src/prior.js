// 分层 Beta-Binomial：先验在选定的 region/service 层内共享，超参数仅由训练期数据估计。
// 矩估计（method of moments），边界解与过度离散均显式标记；无训练数据的层不回退全局先验。

import { logGamma, logBetaBinomialPmf } from './beta.js';

export const PRIOR_LIMITS = { minConcentration: 1, maxConcentration: 10000 };

// 由层内训练期点级计数估计 Beta(alpha,beta) 先验。
// 入参点统一为 { point, success, attempts }（rate 可选）；n_i 次尝试、y_i 次成功。
// μ 为池化率，R 为按 n_i 加权的 p_i 方差。
// Beta-Binomial 矩方程：R = μ(1-μ)(kM+N)/(N(M+1))，解出集中参数 M。
export function estimateLayerPrior(layerKey, rawTrainingPoints, limits = PRIOR_LIMITS) {
  const trainingPoints = rawTrainingPoints.map(item => ({
    point: item.point,
    success: item.success ?? item.y,
    attempts: item.attempts ?? item.n
  }));
  const contributors = trainingPoints
    .filter(item => item.attempts > 0)
    .map(item => ({ point: item.point, y: item.success, n: item.attempts, rate: item.success / item.attempts }));
  const k = contributors.length;
  const N = contributors.reduce((sum, item) => sum + item.n, 0);
  const Sy = contributors.reduce((sum, item) => sum + item.y, 0);
  const base = {
    layerKey,
    estimationTarget: '层内各点成功率共同 Beta 先验 Beta(alpha,beta)，仅使用训练期增量计数',
    method: 'beta-binomial-method-of-moments',
    contributingPoints: contributors.map(item => item.point),
    contributingPointCount: k,
    trainingAttempts: N,
    trainingSuccess: Sy,
    flags: []
  };
  if (k === 0 || N === 0) {
    return { ...base, status: 'unavailable', reason: '层内训练期没有任何尝试次数，超参数不可估计；不使用全局先验替代',
      flags: ['noTrainingData'] };
  }
  const muRaw = Sy / N;
  const R = contributors.reduce((sum, item) => sum + item.n * (item.rate - muRaw) ** 2, 0) / N;
  const binomialVariance = muRaw * (1 - muRaw);
  const flags = [];
  let mu = muRaw;
  if (muRaw === 0 || muRaw === 1) {
    // Haldane–Anscombe 式加 2 平滑，仅用于边界先验，原始池化率同时保留
    mu = (Sy + 1) / (N + 2);
    flags.push('meanBoundary');
  }
  let M;
  if (flags.includes('meanBoundary')) {
    M = limits.maxConcentration;
    flags.push('concentrationAtMax');
  } else if (k === 1) {
    M = limits.maxConcentration;
    flags.push('singlePointConcentrationUnidentified', 'concentrationAtMax');
  } else {
    const numerator = N * (binomialVariance - R);
    const denominator = R * N - k * binomialVariance;
    if (numerator <= 0) {
      // R >= μ(1-μ)：层间离散达到或超过可表达上限，集中参数落在最小边界
      M = limits.minConcentration;
      flags.push('maxOverdispersionBoundary', 'concentrationAtMin');
    } else if (denominator <= 0) {
      // R <= μ(1-μ)/平均样本量：观测不到过度离散，集中参数落在最大边界
      M = limits.maxConcentration;
      flags.push('noDetectableOverdispersion', 'concentrationAtMax');
    } else {
      M = numerator / denominator;
      if (M >= limits.maxConcentration) {
        M = limits.maxConcentration;
        flags.push('concentrationAtMax');
      } else if (M <= limits.minConcentration) {
        M = limits.minConcentration;
        flags.push('concentrationAtMin');
      }
    }
  }
  const alpha = mu * M;
  const beta = (1 - mu) * M;
  const intraClassCorrelation = 1 / (M + 1);
  // 过度离散核对：拟合 Beta-Binomial 与二项（μ 固定）的训练期对数边际
  const logBetaBinomial = contributors.reduce((sum, item) =>
    sum + logBetaBinomialPmf(item.y, item.n, alpha, beta), 0);
  const logBinomial = contributors.reduce((sum, item) => {
    const logChoose = logGamma(item.n + 1) - logGamma(item.y + 1) - logGamma(item.n - item.y + 1);
    if (muRaw === 0 || muRaw === 1) return null;
    return sum + logChoose + item.y * Math.log(muRaw) + (item.n - item.y) * Math.log1p(-muRaw);
  }, 0);
  return {
    ...base,
    status: 'estimated',
    pooledRateRaw: muRaw,
    pooledRateAdjusted: mu,
    weightedRateVariance: R,
    binomialReferenceVariance: binomialVariance,
    concentration: M,
    alpha,
    beta,
    intraClassCorrelation,
    overdispersionFactor: (M + N / k) / (M + 1),
    logMarginalBetaBinomial: logBetaBinomial,
    logMarginalBinomial: Number.isFinite(logBinomial) ? logBinomial : null,
    flags
  };
}

// 共轭后验：Beta(alpha,beta) + (y 成功, n 尝试) -> Beta(alpha+y, beta+n-y)
export function updatePosterior(prior, success, attempts) {
  if (!Number.isSafeInteger(success) || !Number.isSafeInteger(attempts)
      || success < 0 || attempts < 0 || success > attempts) {
    throw new Error('后验更新计数不合法');
  }
  if (!prior || prior.status === 'unavailable') {
    return { status: 'unavailable', reason: prior?.reason || '层先验不可用', alpha: null, beta: null,
      priorAlpha: null, priorBeta: null, addedSuccess: success, addedAttempts: attempts };
  }
  return {
    status: 'estimated',
    priorAlpha: prior.alpha,
    priorBeta: prior.beta,
    addedSuccess: success,
    addedAttempts: attempts,
    alpha: prior.alpha + success,
    beta: prior.beta + attempts - success
  };
}
