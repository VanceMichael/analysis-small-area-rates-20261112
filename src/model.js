// Beta-Binomial 分层分析：共轭后验、阈值以下后验概率、排序不确定性与固定结构标准化。
// 先验来自训练窗口的分层经验贝叶斯；没有先验的层不会被静默并入全局先验，而是显式排除。

import {
  betaCdf, betaMean, betaQuantile, betaSample, betaVariance,
  conjugateUpdate, createRng,
} from './beta.js';
import { layerKeyOf } from './prior.js';

const CREDIBLE_PROBABILITY = 0.95;

function aggregatePoint(rows, poolBy, trainingWindow) {
  const first = rows[0];
  for (const row of rows) {
    for (const field of poolBy) {
      if (row[field] !== first[field]) {
        throw new Error(`点 ${first.point} 的分层字段 ${field} 在不同期间不一致，不能共享同一层身份`);
      }
    }
  }
  const success = rows.reduce((sum, row) => sum + row.successDelta, 0);
  const attempts = rows.reduce((sum, row) => sum + row.attemptsDelta, 0);
  const resets = rows.filter(row => row.reset);
  const training = rows.filter(row => row.period <= trainingWindow.through && row.period >= trainingWindow.from);
  const postTraining = rows.filter(row => row.period > trainingWindow.through);
  return {
    point: first.point,
    layerKey: layerKeyOf(first, poolBy),
    dimensions: Object.fromEntries(poolBy.map(field => [field, first[field]])),
    periods: rows.map(row => row.period),
    success,
    attempts,
    rawRate: attempts === 0 ? null : success / attempts,
    resetCount: resets.length,
    resetPeriods: resets.map(row => row.period),
    trainingSuccess: training.reduce((sum, row) => sum + row.successDelta, 0),
    trainingAttempts: training.reduce((sum, row) => sum + row.attemptsDelta, 0),
    postTrainingSuccess: postTraining.reduce((sum, row) => sum + row.successDelta, 0),
    postTrainingAttempts: postTraining.reduce((sum, row) => sum + row.attemptsDelta, 0),
  };
}

function summarizePosterior(point, prior, threshold) {
  const updated = conjugateUpdate(prior.alpha, prior.beta, point.success, point.attempts);
  const mean = betaMean(updated.alpha, updated.beta);
  const variance = betaVariance(updated.alpha, updated.beta);
  return {
    priorMu: prior.mu,
    priorConcentration: prior.k,
    alpha: updated.alpha,
    beta: updated.beta,
    posteriorMean: mean,
    posteriorStandardDeviation: Math.sqrt(variance),
    credibleInterval: {
      probability: CREDIBLE_PROBABILITY,
      lower: betaQuantile((1 - CREDIBLE_PROBABILITY) / 2, updated.alpha, updated.beta),
      upper: betaQuantile((1 + CREDIBLE_PROBABILITY) / 2, updated.alpha, updated.beta),
    },
    // P(theta < threshold | 数据)，直接由 Beta 累积分布给出，不靠模拟。
    probabilityBelowThreshold: betaCdf(threshold, updated.alpha, updated.beta),
    dataWeight: point.attempts / (prior.k + point.attempts),
    zeroAttempts: point.attempts === 0,
  };
}

// 固定种子的蒙特卡洛排序：输出每个点的名次分布摘要与夺冠/前三概率。
function monteCarloRanking(points, posteriorByPoint, { seed, draws }) {
  const ranked = points.filter(point => posteriorByPoint.has(point.point));
  const rng = createRng(seed);
  const samplesByPoint = new Map();
  for (const point of ranked) {
    const posterior = posteriorByPoint.get(point.point);
    const samples = new Float64Array(draws);
    for (let i = 0; i < draws; i += 1) samples[i] = betaSample(rng, posterior.alpha, posterior.beta);
    samplesByPoint.set(point.point, samples);
  }
  const summary = new Map();
  for (const point of ranked) {
    const mine = samplesByPoint.get(point.point);
    const ranks = new Uint32Array(draws);
    let topOne = 0;
    let topThree = 0;
    for (let draw = 0; draw < draws; draw += 1) {
      let rank = 1;
      for (const other of ranked) {
        if (other.point === point.point) continue;
        if (samplesByPoint.get(other.point)[draw] > mine[draw]) rank += 1;
      }
      ranks[draw] = rank;
      if (rank === 1) topOne += 1;
      if (rank <= 3) topThree += 1;
    }
    const sortedRanks = Array.from(ranks).sort((left, right) => left - right);
    const quantile = probability => Math.min(draws - 1, Math.max(0, Math.floor(probability * draws)));
    const prTop1 = topOne / draws;
    summary.set(point.point, {
      medianRank: sortedRanks[quantile(0.5)],
      rankInterval95: [sortedRanks[quantile(0.025)], sortedRanks[quantile(0.975)]],
      probabilityTop1: prTop1,
      probabilityTop3: topThree / draws,
      monteCarloStandardError: Math.sqrt(prTop1 * (1 - prTop1) / draws),
    });
  }
  // 层内夺冠概率，用于同层资源比较。
  const layerWinner = new Map();
  for (const point of ranked) {
    const mine = samplesByPoint.get(point.point);
    const peers = ranked.filter(other => other.layerKey === point.layerKey && other.point !== point.point);
    if (peers.length === 0) {
      layerWinner.set(point.point, 1);
      continue;
    }
    let wins = 0;
    for (let draw = 0; draw < draws; draw += 1) {
      if (peers.every(other => samplesByPoint.get(other.point)[draw] < mine[draw])) wins += 1;
    }
    layerWinner.set(point.point, wins / draws);
  }
  return { scope: 'all_estimable_points', seed, draws, rankedCount: ranked.length, summary, layerWinner };
}

function standardize(increments, points, priorEstimation, standardWeights, poolBy) {
  const weightEntries = Object.entries(standardWeights);
  const totalWeight = weightEntries.reduce((sum, [, weight]) => sum + weight, 0);
  if (weightEntries.length === 0 || Math.abs(totalWeight - 1) > 1e-9) {
    throw new Error('standardWeights 必须为非空权重且合计为 1');
  }
  if (weightEntries.some(([, weight]) => !(weight > 0))) throw new Error('standardWeights 权重必须为正');
  const regionField = poolBy.includes('region') ? 'region' : poolBy[0];
  const serviceField = poolBy.includes('service') ? 'service' : poolBy[1];
  const services = [...new Set(points.map(point => point.dimensions[serviceField]))].sort();
  return services.map(service => {
    const layerResults = [];
    let crudeSuccess = 0;
    let crudeAttempts = 0;
    for (const [region, weight] of weightEntries) {
      const dimensions = { [regionField]: region, [serviceField]: service };
      const layerKey = poolBy.map(field => dimensions[field]).join('\u0001');
      const prior = priorEstimation.priorByLayer[layerKey];
      const layerRows = increments.filter(row => row.region === region && row.service === service);
      const success = layerRows.reduce((sum, row) => sum + row.successDelta, 0);
      const attempts = layerRows.reduce((sum, row) => sum + row.attemptsDelta, 0);
      crudeSuccess += success;
      crudeAttempts += attempts;
      if (!prior) {
        layerResults.push({ region, weight, included: false,
          reason: 'layer_without_prior_or_absent', attempts, success });
        continue;
      }
      const aggregate = conjugateUpdate(prior.alpha, prior.beta, success, attempts);
      layerResults.push({
        region,
        weight,
        included: true,
        attempts,
        success,
        layerPosteriorMean: betaMean(aggregate.alpha, aggregate.beta),
        layerRawRate: attempts === 0 ? null : success / attempts,
      });
    }
    const included = layerResults.filter(layer => layer.included);
    // 固定结构：直接按业务权重加权，不按覆盖范围重新归一化；缺层以 includedWeight 显式暴露。
    const standardizedRate = included.reduce((sum, layer) => sum + layer.weight * layer.layerPosteriorMean, 0);
    const standardizedRawRate = included
      .filter(layer => layer.layerRawRate !== null)
      .reduce((sum, layer) => sum + layer.weight * layer.layerRawRate, 0);
    return {
      service,
      standardizedRate,
      standardizedRawRate,
      crudePooledRate: crudeAttempts === 0 ? null : crudeSuccess / crudeAttempts,
      includedWeight: included.reduce((sum, layer) => sum + layer.weight, 0),
      layers: layerResults,
      whyNotOverallRate: '标准化率按固定业务结构（standardWeights）对各层后验均值加权，回答“结构不变时服务表现如何”；'
        + '总体率是全部成功数除以全部尝试次数，混合了各层交易量结构，会被大层和交易量波动主导，两者不是同一估计目标。',
    };
  });
}

export function analyze(increments, priorEstimation, policy, monteCarlo = { seed: 20261114, draws: 10000 }) {
  const { threshold, poolBy, standardWeights } = policy;
  if (!(threshold > 0 && threshold < 1)) throw new Error('threshold 必须在 (0,1) 内');
  const byPoint = new Map();
  for (const row of increments) {
    if (!byPoint.has(row.point)) byPoint.set(row.point, []);
    byPoint.get(row.point).push(row);
  }
  const points = [...byPoint.keys()].sort((left, right) => left.localeCompare(right, 'en'))
    .map(point => aggregatePoint(byPoint.get(point), poolBy, priorEstimation.trainingWindow));
  const posteriorByPoint = new Map();
  const enriched = points.map(point => {
    const prior = priorEstimation.priorByLayer[point.layerKey];
    if (!prior) {
      return { ...point, status: 'excluded_layer_without_prior', posterior: null,
        note: '该层训练窗口无数据，未借用全局或其他层先验' };
    }
    const posterior = summarizePosterior(point, prior, threshold);
    posteriorByPoint.set(point.point, posterior);
    return { ...point, status: 'estimated', posterior };
  });
  const ranking = monteCarloRanking(points, posteriorByPoint, monteCarlo);
  for (const point of enriched) {
    const rankSummary = ranking.summary.get(point.point);
    if (rankSummary) {
      point.ranking = { ...rankSummary, probabilityBestInLayer: ranking.layerWinner.get(point.point) };
    }
  }
  return {
    configuration: {
      threshold,
      poolBy,
      trainingWindow: priorEstimation.trainingWindow,
      monteCarlo: { seed: ranking.seed, draws: ranking.draws, rankedCount: ranking.rankedCount },
    },
    points: enriched,
    standardization: standardize(increments, points, priorEstimation, standardWeights, poolBy),
  };
}
