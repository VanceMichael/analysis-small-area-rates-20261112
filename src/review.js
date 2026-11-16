// Beta-Binomial 资源复核主流程：
// 台账重建 -> 训练窗口封存 -> 层先验估计 -> 共轭后验 -> 精确阈值概率 -> 排序不确定性 -> 固定结构标准化。
// 输出按 point 稳定标识排列，不提供按均值排好的排行榜。

import { fingerprint, canonical } from './dataset.js';
import { reconstructLedger, splitWindow } from './ledger.js';
import { estimateLayerPrior, updatePosterior, PRIOR_LIMITS } from './prior.js';
import { posteriorSummary, probabilityBelow, probabilityAtLeast, rankAnalysis } from './simulate.js';
import { layerPooledPosterior, standardize } from './standardize.js';
import { resolveLayerWeights } from './policy.js';

function decideAction(probability, review) {
  if (probability == null) return { action: 'data-gap', reason: '层先验不可用，仅保留原始率与台账证据' };
  if (probability >= review.actionProbability) return { action: 'adjust-resource', reason: `低于阈值的后验概率 >= ${review.actionProbability}` };
  if (probability >= review.watchProbability) return { action: 'watch', reason: `低于阈值的后验概率位于 [${review.watchProbability}, ${review.actionProbability})` };
  return { action: 'hold', reason: `低于阈值的后验概率 < ${review.watchProbability}` };
}

export function runReview(records, policy, options = {}) {
  const limits = { ...PRIOR_LIMITS, maxConcentration: policy.review.concentrationCap };
  const ledger = reconstructLedger(records, policy.asOf);
  const layerKeys = [...new Set(ledger.points.map(item => item.layerKey))].sort((a, b) => a.localeCompare(b, 'en'));
  const layers = new Map(layerKeys.map(key => [key, []]));
  const pointWindows = new Map();
  for (const item of ledger.points) {
    const windows = splitWindow(item, policy.trainThrough);
    pointWindows.set(item.point, windows);
    layers.get(item.layerKey).push({ point: item.point, ...windows.training });
  }
  const priors = new Map();
  const layerReports = [];
  for (const layerKey of layerKeys) {
    const prior = estimateLayerPrior(layerKey, layers.get(layerKey), limits);
    priors.set(layerKey, prior);
    layerReports.push(prior);
  }
  const points = ledger.points.map(item => {
    const windows = pointWindows.get(item.point);
    const prior = priors.get(item.layerKey);
    const posterior = updatePosterior(prior, windows.analysis.success, windows.analysis.attempts);
    const summary = posteriorSummary(posterior, policy.credibleLevel);
    const rawRate = windows.analysis.attempts === 0 ? null : windows.analysis.success / windows.analysis.attempts;
    const trainingRawRate = windows.training.attempts === 0 ? null : windows.training.success / windows.training.attempts;
    const pBelow = probabilityBelow(policy.threshold, posterior);
    const pAtLeast = probabilityAtLeast(policy.threshold, posterior);
    const decision = decideAction(pBelow, policy.review);
    // 共轭手算核对：先验参数 + 计数必须逐字段等于后验参数（容差针对浮点运算顺序）
    const conjugateCheck = posterior.status === 'unavailable' ? { status: 'skipped', reason: posterior.reason } : (() => {
      const handAlpha = prior.alpha + windows.analysis.success;
      const handBeta = prior.beta + (windows.analysis.attempts - windows.analysis.success);
      const tolerance = 1e-10 * Math.max(1, Math.abs(posterior.alpha), Math.abs(posterior.beta));
      const match = Math.abs(handAlpha - posterior.alpha) <= tolerance
        && Math.abs(handBeta - posterior.beta) <= tolerance;
      return {
        status: match ? 'pass' : 'fail',
        priorAlpha: prior.alpha,
        priorBeta: prior.beta,
        addedSuccess: windows.analysis.success,
        addedFailures: windows.analysis.attempts - windows.analysis.success,
        handAlpha,
        handBeta,
        posteriorAlpha: posterior.alpha,
        posteriorBeta: posterior.beta
      };
    })();
    return {
      point: item.point,
      region: item.region,
      service: item.service,
      layerKey: item.layerKey,
      resetPeriods: item.resets.map(entry => entry.period),
      trainingWindow: windows.training,
      analysisWindow: windows.analysis,
      trainingPeriods: windows.trainingPeriods,
      analysisPeriods: windows.analysisPeriods,
      rawRate,
      trainingRawRate,
      priorStatus: prior.status,
      posterior: summary,
      threshold: policy.threshold,
      probabilityBelowThreshold: pBelow,
      probabilityAtLeastThreshold: pAtLeast,
      decision: decision.action,
      decisionReason: decision.reason,
      conjugateCheck
    };
  }).sort((a, b) => a.point.localeCompare(b.point, 'en'));
  const rankEntries = points.map(item => ({
    point: item.point,
    alpha: item.posterior.status === 'estimated' ? item.posterior.alpha : null,
    beta: item.posterior.status === 'estimated' ? item.posterior.beta : null,
    reason: item.posterior.status === 'unavailable' ? item.posterior.reason : undefined
  }));
  const ranking = rankAnalysis(rankEntries, { draws: policy.draws, seed: policy.seed });
  // 层池化后验与固定结构标准化
  const layerPosteriors = layerKeys.map(layerKey => {
    const totals = ledger.points
      .filter(item => item.layerKey === layerKey)
      .reduce((acc, item) => {
        const windows = pointWindows.get(item.point);
        return { success: acc.success + windows.analysis.success, attempts: acc.attempts + windows.analysis.attempts };
      }, { success: 0, attempts: 0 });
    return layerPooledPosterior(priors.get(layerKey), totals);
  });
  const weights = resolveLayerWeights(policy, layerKeys);
  const unknownWeightLayers = Object.keys(weights).filter(key => !layerKeys.includes(key));
  if (unknownWeightLayers.length > 0) throw new Error(`标准化权重出现数据中不存在的层：${unknownWeightLayers.join(', ')}`);
  const missingWeightLayers = layerKeys.filter(key => !(key in weights));
  if (missingWeightLayers.length > 0) throw new Error(`以下层缺少固定标准化权重：${missingWeightLayers.join(', ')}`);
  const standardization = standardize(layerPosteriors, weights, {
    draws: policy.draws,
    seed: policy.seed + 1,
    credibleLevel: policy.credibleLevel
  });
  const failures = points.filter(item => item.conjugateCheck.status === 'fail');
  const report = {
    schema: 'small-area-review/v1',
    run: {
      trainThrough: policy.trainThrough,
      asOf: policy.asOf,
      threshold: policy.threshold,
      credibleLevel: policy.credibleLevel,
      draws: policy.draws,
      seed: policy.seed,
      poolBy: [...policy.poolBy],
      inputFingerprint: fingerprint([...records].sort((a, b) => a.id.localeCompare(b.id, 'en')))
    },
    ledgerAudit: ledger.audit,
    layerPriors: layerReports,
    points,
    ranking,
    standardization,
    checks: {
      conjugate: { total: points.length, failures: failures.length, allPass: failures.length === 0 },
      unavailablePriorPoints: points.filter(item => item.priorStatus === 'unavailable').map(item => item.point),
      resetPoints: points.filter(item => item.resetPeriods.length > 0).map(item => ({
        point: item.point, resetPeriods: item.resetPeriods
      }))
    }
  };
  if (failures.length > 0) throw new Error('共轭后验手算核对未通过，拒绝输出复核结果');
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  // 指纹覆盖全部分析内容（时间戳在计算后附加），保证同输入同种子结果可复现
  const canonicalFingerprint = fingerprint(canonical(report));
  return { ...report, run: { ...report.run, generatedAt }, canonicalFingerprint };
}
