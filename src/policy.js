// 业务策略：训练窗口、as_of 截止、业务阈值、分层字段、固定标准化结构与推断参数。

const DEFAULT_POLICY = {
  version: 2,
  credibleLevel: 0.9,
  draws: 50000,
  seed: 20261116,
  review: { watchProbability: 0.5, actionProbability: 0.8, concentrationCap: 10000 }
};

function assertNumber(name, value, test) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !test(value)) {
    throw new Error(`policy.${name} 取值不合法：${value}`);
  }
}

export function loadPolicy(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('策略配置必须是对象');
  if (raw.version !== 2) throw new Error(`不支持的策略版本 ${raw.version}，当前仅支持 2`);
  if (!Array.isArray(raw.poolBy) || raw.poolBy.length === 0
      || raw.poolBy.some(field => !['region', 'service'].includes(field))) {
    throw new Error('poolBy 必须是 region/service 的非空数组');
  }
  assertNumber('trainThrough', raw.trainThrough, value => Number.isSafeInteger(value) && value >= 0);
  assertNumber('asOf', raw.asOf, value => Number.isSafeInteger(value) && value >= raw.trainThrough);
  assertNumber('threshold', raw.threshold, value => value > 0 && value < 1);
  assertNumber('credibleLevel', raw.credibleLevel ?? DEFAULT_POLICY.credibleLevel, value => value > 0 && value < 1);
  assertNumber('draws', raw.draws ?? DEFAULT_POLICY.draws, value => Number.isSafeInteger(value) && value >= 1000);
  assertNumber('seed', raw.seed ?? DEFAULT_POLICY.seed, value => Number.isSafeInteger(value) && value >= 0);
  const hasLayerWeights = raw.layerWeights && typeof raw.layerWeights === 'object';
  const hasRegionWeights = raw.standardWeights && typeof raw.standardWeights === 'object';
  if (!hasLayerWeights && !hasRegionWeights) throw new Error('必须提供 layerWeights 或 standardWeights');
  if (hasLayerWeights && hasRegionWeights) throw new Error('layerWeights 与 standardWeights 只能提供一种');
  const review = { ...DEFAULT_POLICY.review, ...(raw.review ?? {}) };
  assertNumber('review.watchProbability', review.watchProbability, value => value > 0 && value < 1);
  assertNumber('review.actionProbability', review.actionProbability, value => value > 0 && value < 1);
  if (review.actionProbability <= review.watchProbability) {
    throw new Error('review.actionProbability 必须大于 review.watchProbability');
  }
  assertNumber('review.concentrationCap', review.concentrationCap, value => value >= 1);
  return {
    ...DEFAULT_POLICY,
    ...raw,
    credibleLevel: raw.credibleLevel ?? DEFAULT_POLICY.credibleLevel,
    draws: raw.draws ?? DEFAULT_POLICY.draws,
    seed: raw.seed ?? DEFAULT_POLICY.seed,
    review,
    layerWeights: hasLayerWeights ? raw.layerWeights : null,
    regionWeights: hasRegionWeights ? raw.standardWeights : null
  };
}

// region 权重在层维度展开（service 间等权）；两种来源都归一为 layerKey -> 权重。
export function resolveLayerWeights(policy, layerKeys) {
  if (policy.layerWeights) return policy.layerWeights;
  const services = new Set(layerKeys.map(key => key.split('/')[1]));
  const serviceCount = services.size;
  const weights = {};
  for (const layerKey of layerKeys) {
    const [region, service] = layerKey.split('/');
    const regionWeight = policy.regionWeights[region];
    if (typeof regionWeight !== 'number') throw new Error(`region ${region} 缺少固定结构权重`);
    weights[layerKey] = regionWeight / serviceCount;
    void service;
  }
  return weights;
}
