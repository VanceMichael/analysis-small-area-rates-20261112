// 后验摘要：阈值以下后验概率用正则化不完全 Beta 精确计算；
// 排序不确定性（名次分布、前 k 概率、成对占优）用确定性 splitmix64 蒙特卡洛，
// 并报告 MC 标准误，抽样规模固定使结果可复现。

import {
  betaIncomplete, betaInverse, betaMean, betaVariance,
  createRng, betaSample
} from './beta.js';

export const DEFAULT_DRAWS = 50000;

export function posteriorSummary(posterior, credibleLevel = 0.9) {
  if (posterior.status === 'unavailable') {
    return { status: 'unavailable', reason: posterior.reason, credible: null };
  }
  const { alpha, beta } = posterior;
  const tail = (1 - credibleLevel) / 2;
  return {
    status: 'estimated',
    alpha,
    beta,
    mean: betaMean(alpha, beta),
    variance: betaVariance(alpha, beta),
    stdDev: Math.sqrt(betaVariance(alpha, beta)),
    credible: {
      level: credibleLevel,
      lower: betaInverse(tail, alpha, beta),
      upper: betaInverse(1 - tail, alpha, beta)
    }
  };
}

// P(theta < threshold)，精确分布计算，不依赖抽样
export function probabilityBelow(threshold, posterior) {
  if (posterior.status === 'unavailable') return null;
  return betaIncomplete(threshold, posterior.alpha, posterior.beta);
}

export function probabilityAtLeast(threshold, posterior) {
  if (posterior.status === 'unavailable') return null;
  return 1 - betaIncomplete(threshold, posterior.alpha, posterior.beta);
}

function bernoulliSe(estimate, draws) {
  return Math.sqrt((estimate * (1 - estimate)) / draws);
}

// 对先验可用的点做联合抽样；先验不可用的点不参与排序，单独列出。
// entries: [{ point, alpha, beta }]（按 point 排序后传入）
export function rankAnalysis(entries, options = {}) {
  const draws = options.draws ?? DEFAULT_DRAWS;
  const seed = options.seed ?? 20261116;
  if (!Number.isSafeInteger(draws) || draws <= 0) throw new Error('抽样次数必须为正整数');
  const available = entries.filter(item => item.alpha != null && item.beta != null);
  const unavailable = entries.filter(item => item.alpha == null || item.beta == null)
    .map(item => ({ point: item.point, reason: item.reason || '层先验不可用' }));
  const m = available.length;
  if (m === 0) {
    return { draws, seed, points: unavailable, rankings: [], pairwise: [], unavailable };
  }
  const rng = createRng(seed);
  const rankCounts = available.map(() => new Int32Array(m));
  const topCounts = available.map(() => new Int32Array(m));
  const pairWins = available.map(() => new Int32Array(m));
  const values = new Float64Array(m);
  for (let draw = 0; draw < draws; draw += 1) {
    for (let i = 0; i < m; i += 1) values[i] = betaSample(rng, available[i].alpha, available[i].beta);
    const order = [...values.keys()].sort((a, b) => values[b] - values[a] || a - b);
    for (let rank = 0; rank < m; rank += 1) {
      const index = order[rank];
      rankCounts[index][rank] += 1;
      for (let k = rank; k < m; k += 1) topCounts[index][k] += 1;
    }
    for (let i = 0; i < m; i += 1) {
      for (let j = 0; j < m; j += 1) {
        if (values[i] > values[j]) pairWins[i][j] += 1;
      }
    }
  }
  const rankings = available.map((item, i) => {
    const rankDistribution = [];
    let cumulative = 0;
    const topK = [];
    for (let rank = 0; rank < m; rank += 1) {
      const probability = rankCounts[i][rank] / draws;
      rankDistribution.push({ rank: rank + 1, probability, standardError: bernoulliSe(probability, draws) });
      cumulative = topCounts[i][rank] / draws;
      topK.push({ k: rank + 1, probability: cumulative, standardError: bernoulliSe(cumulative, draws) });
    }
    const expectedRank = rankDistribution.reduce((sum, cell) => sum + cell.rank * cell.probability, 0);
    return { point: item.point, expectedRank, rankDistribution, topK };
  });
  const pairwise = available.map((item, i) => ({
    point: item.point,
    beats: available.map((other, j) => {
      if (i === j) return { point: other.point, probability: null, standardError: null };
      const probability = pairWins[i][j] / draws;
      return { point: other.point, probability, standardError: bernoulliSe(probability, draws) };
    })
  }));
  return { draws, seed, rankings, pairwise, unavailable };
}
