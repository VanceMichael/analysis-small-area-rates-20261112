// 跨层标准化：按固定业务结构（与交易量无关的层权重）合成层率，
// 与按实际交易量加权的总体粗率并列，二者回答不同问题，不能互相替代。

import { betaMean, betaVariance, createRng, betaSample } from './beta.js';

// weights: { layerKey: weight }。先对完整策略权重做合法性校验，
// 再按先验可用层重新归一化（不可用层在 missingLayers 中显式列出）。
export function resolveStandardWeights(availableLayerKeys, configuredWeights) {
  const entries = Object.entries(configuredWeights);
  if (entries.length === 0) throw new Error('标准化权重为空');
  for (const [layerKey, weight] of entries) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new Error(`层 ${layerKey} 的标准化权重必须是 (0,1] 内的有限数`);
    }
  }
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  if (Math.abs(total - 1) > 1e-12) throw new Error(`标准化权重之和必须为 1，当前为 ${total}`);
  const available = new Set(availableLayerKeys);
  const usableEntries = entries.filter(([layerKey]) => available.has(layerKey));
  if (usableEntries.length === 0) throw new Error('没有任何先验可用层可以标准化');
  const usableTotal = usableEntries.reduce((sum, [, weight]) => sum + weight, 0);
  return Object.fromEntries(usableEntries
    .map(([layerKey, weight]) => [layerKey, weight / usableTotal])
    .sort(([a], [b]) => a.localeCompare(b, 'en')));
}

// 层后验 = 共享先验 + 层内分析期全部增量（共轭可加）。
export function layerPooledPosterior(prior, layerAnalysisTotals) {
  if (prior.status === 'unavailable') {
    return { layerKey: prior.layerKey, status: 'unavailable', reason: prior.reason,
      totals: layerAnalysisTotals };
  }
  const alpha = prior.alpha + layerAnalysisTotals.success;
  const beta = prior.beta + layerAnalysisTotals.attempts - layerAnalysisTotals.success;
  return { layerKey: prior.layerKey, status: 'estimated', alpha, beta, totals: layerAnalysisTotals };
}

export function standardize(layerPosteriors, weights, options = {}) {
  const draws = options.draws ?? 50000;
  const seed = options.seed ?? 20261117;
  const credibleLevel = options.credibleLevel ?? 0.9;
  const usable = layerPosteriors.filter(item => item.status === 'estimated');
  const missing = layerPosteriors.filter(item => item.status === 'unavailable')
    .map(item => ({ layerKey: item.layerKey, reason: item.reason }));
  if (usable.length === 0) {
    return { status: 'unavailable', missingLayers: missing, layers: [] };
  }
  const resolved = resolveStandardWeights(usable.map(item => item.layerKey), weights);
  const layers = usable.map(item => {
    const weight = resolved[item.layerKey];
    const mean = betaMean(item.alpha, item.beta);
    const variance = betaVariance(item.alpha, item.beta);
    return { layerKey: item.layerKey, weight, alpha: item.alpha, beta: item.beta,
      mean, variance, analysisAttempts: item.totals.attempts, analysisSuccess: item.totals.success };
  }).sort((a, b) => a.layerKey.localeCompare(b.layerKey, 'en'));
  // 固定权重混合分布的解析矩
  const standardizedMean = layers.reduce((sum, item) => sum + item.weight * item.mean, 0);
  const standardizedVariance = layers.reduce((sum, item) =>
    sum + item.weight ** 2 * item.variance
    + item.weight * (item.mean - standardizedMean) ** 2, 0);
  // 混合分布可信区间走抽样，独立随机流
  const rng = createRng(seed);
  const samples = new Float64Array(draws);
  for (let draw = 0; draw < draws; draw += 1) {
    let value = 0;
    for (const layer of layers) {
      value += layer.weight * betaSample(rng, layer.alpha, layer.beta);
    }
    samples[draw] = value;
  }
  const sorted = Float64Array.from(samples).sort();
  const tail = (1 - credibleLevel) / 2;
  const quantile = p => sorted[Math.min(draws - 1, Math.max(0, Math.floor(p * draws)))];
  // 按实际交易量加权的总体粗率（所有分析期交易汇总），仅用于对照
  const totalAttempts = layers.reduce((sum, item) => sum + item.analysisAttempts, 0);
  const totalSuccess = layers.reduce((sum, item) => sum + item.analysisSuccess, 0);
  const crudeRate = totalAttempts === 0 ? null : totalSuccess / totalAttempts;
  const volumeWeights = Object.fromEntries(layers.map(item =>
    [item.layerKey, totalAttempts === 0 ? null : item.analysisAttempts / totalAttempts]));
  return {
    status: missing.length === 0 ? 'estimated' : 'partial',
    weights: Object.fromEntries(layers.map(item => [item.layerKey, item.weight])),
    standardizedRate: {
      mean: standardizedMean,
      variance: standardizedVariance,
      stdDev: Math.sqrt(standardizedVariance),
      credible: { level: credibleLevel, lower: quantile(tail), upper: quantile(1 - tail) },
      draws,
      seed
    },
    crudePooledRate: crudeRate,
    crudePooled: { success: totalSuccess, attempts: totalAttempts },
    volumeWeights,
    layers,
    missingLayers: missing,
    note: '标准化率使用与交易量无关的固定层权重混合层后验；总体粗率按实际尝试次数加权，两者结构不同，不应互相替代'
  };
}
