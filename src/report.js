// 面向运营的资源复核清单：不输出按均值排好的榜，而是给出阈值后验概率与排序不确定性。
// 小点保留在清单中并显式标注样本量；全成功、零尝试、重置与无先验层都有明确标记。

const PERCENT = value => `${(value * 100).toFixed(1)}%`;
const RATE = value => (value === null || value === undefined ? '—' : (value * 100).toFixed(2) + '%');
const layerLabel = (layer, poolBy) => poolBy.map(field => `${field}=${layer.dimensions[field]}`).join('，');

function flagsOf(point) {
  const flags = [];
  if (point.status === 'excluded_layer_without_prior') flags.push('无层先验-排除');
  if (point.zeroAttempts || point.attempts === 0) flags.push('零尝试');
  if (point.attempts > 0 && point.success === point.attempts) flags.push('全成功');
  if (point.resetCount > 0) flags.push(`重置×${point.resetCount}`);
  if (point.attempts > 0 && point.attempts < 10) flags.push('小样本');
  return flags.join('、');
}

function pointRow(point) {
  if (point.status === 'excluded_layer_without_prior') {
    return `| ${point.point} | ${point.dimensions.region}/${point.dimensions.service} | ${point.attempts} | ${RATE(point.rawRate)} | — | — | — | — | — | — | ${flagsOf(point)} |`;
  }
  const posterior = point.posterior;
  const ranking = point.ranking;
  return [
    `| ${point.point}`,
    `${point.dimensions.region}/${point.dimensions.service}`,
    `${point.attempts}`,
    RATE(point.rawRate),
    RATE(posterior.posteriorMean),
    `[${RATE(posterior.credibleInterval.lower)}, ${RATE(posterior.credibleInterval.upper)}]`,
    PERCENT(posterior.probabilityBelowThreshold),
    `#${ranking.medianRank} [${ranking.rankInterval95[0]}-${ranking.rankInterval95[1]}]`,
    PERCENT(ranking.probabilityTop1),
    PERCENT(ranking.probabilityTop3),
    `${flagsOf(point)} |`,
  ].join(' | ');
}

export function renderReport(result) {
  const { analysis, priors, asOf, ledger, inputFingerprint } = result;
  const points = analysis.points;
  const estimated = points.filter(point => point.status === 'estimated');
  // 清单按阈值风险排列，而不是按后验均值出榜；并列时用点键保证稳定。
  const watchlist = [...estimated]
    .sort((left, right) => right.posterior.probabilityBelowThreshold - left.posterior.probabilityBelowThreshold
      || left.point.localeCompare(right.point, 'en'))
    .filter(point => point.posterior.probabilityBelowThreshold >= 0.5);
  const head = [...estimated]
    .sort((left, right) => right.ranking.probabilityTop1 - left.ranking.probabilityTop1
      || left.point.localeCompare(right.point, 'en'))
    .slice(0, 5);
  const lines = [];
  lines.push('# 外卡服务点资源复核清单（Beta-Binomial 分层分析）');
  lines.push('');
  lines.push(`- 分析时点 as_of <= ${asOf}；训练窗口 period ${priors.trainingWindow.from}-${priors.trainingWindow.through}；业务阈值 ${RATE(analysis.configuration.threshold)}`);
  lines.push(`- 分层：${priors.poolBy.join(' × ')}；输入指纹：${inputFingerprint.slice(0, 16)}…；蒙特卡洛：${analysis.configuration.monteCarlo.draws} 次抽样（种子 ${analysis.configuration.monteCarlo.seed}，可复算）`);
  lines.push(`- 合法上报 ${ledger.legalRecordCount} 条；被替代修订 ${ledger.supersededRecordIds.length} 条；未来时点修订（本次不可见）${ledger.futureRecordIds.length} 条；台账重置 ${ledger.resets.length} 处`);
  lines.push('');
  lines.push('## 一、全量复核清单（按“低于阈值的后验概率”降序，非排名榜）');
  lines.push('');
  lines.push('| 点 | 层 | 尝试数 | 原始率 | 收缩后验均值 | 95%可信区间 | P(率<阈值) | 后验名次(95%区间) | 夺冠概率 | 前三概率 | 标记 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  const ordered = [...points].sort((left, right) => {
    if (left.status === 'excluded_layer_without_prior') return 1;
    if (right.status === 'excluded_layer_without_prior') return -1;
    return right.posterior.probabilityBelowThreshold - left.posterior.probabilityBelowThreshold
      || left.point.localeCompare(right.point, 'en');
  });
  for (const point of ordered) lines.push(pointRow(point));
  lines.push('');
  lines.push('## 二、阈值复核（决策：哪些点低于业务阈值）');
  lines.push('');
  if (watchlist.length === 0) {
    lines.push('没有点的后验概率 P(率<阈值) 达到 50%，无需优先复核。');
  } else {
    lines.push('以下点“低于阈值”的后验概率不低于 50%，建议优先安排资源复核：');
    lines.push('');
    lines.push('| 点 | 层 | 尝试数 | 原始率 | 后验均值 | P(率<阈值) | 95%可信区间 | 标记 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const point of watchlist) {
      lines.push(`| ${point.point} | ${point.dimensions.region}/${point.dimensions.service} | ${point.attempts} | ${RATE(point.rawRate)} | ${RATE(point.posterior.posteriorMean)} | ${PERCENT(point.posterior.probabilityBelowThreshold)} | [${RATE(point.posterior.credibleInterval.lower)}, ${RATE(point.posterior.credibleInterval.upper)}] | ${flagsOf(point)} |`);
    }
  }
  lines.push('');
  lines.push('## 三、头部位置可靠性（决策：前几名的位置是否可靠）');
  lines.push('');
  lines.push('名次来自后验抽样的分布而非点估计，因此两笔全成的小点不会得到确定的冠军头衔：');
  lines.push('');
  lines.push('| 点 | 层 | 尝试数 | 后验均值 | 后验名次中位数 | 名次95%区间 | 夺冠概率 | 层内夺冠概率 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const point of head) {
    lines.push(`| ${point.point} | ${point.dimensions.region}/${point.dimensions.service} | ${point.attempts} | ${RATE(point.posterior.posteriorMean)} | #${point.ranking.medianRank} | [${point.ranking.rankInterval95[0]}, ${point.ranking.rankInterval95[1]}] | ${PERCENT(point.ranking.probabilityTop1)} | ${PERCENT(point.ranking.probabilityBestInLayer)} |`);
  }
  lines.push('');
  lines.push('## 四、固定业务结构标准化（跨层资源比较）');
  lines.push('');
  lines.push('| 服务 | 标准化后验率 | 同结构原始率 | 全体交易总体率（不同口径） | 覆盖权重 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const item of analysis.standardization) {
    lines.push(`| ${item.service} | ${RATE(item.standardizedRate)} | ${RATE(item.standardizedRawRate)} | ${RATE(item.crudePooledRate)} | ${PERCENT(item.includedWeight)} |`);
  }
  lines.push('');
  for (const item of analysis.standardization) {
    lines.push(`- **${item.service}**：${item.whyNotOverallRate}`);
  }
  lines.push('');
  lines.push('## 五、先验与方法说明');
  lines.push('');
  for (const layer of priors.layers) {
    const label = layerLabel(layer, priors.poolBy);
    if (!layer.estimable) {
      lines.push(`- 层（${label}）：训练窗口无数据（${layer.status}），该层点不借用全局先验，已排除出后验与排序。`);
      continue;
    }
    const prior = layer.prior;
    const boundary = layer.boundary.length ? layer.boundary.join('、') : '内部解';
    const dispersion = layer.overdispersion
      ? `ICC=${layer.overdispersion.intraclassCorrelation.toFixed(4)}，方差比=${layer.overdispersion.varianceRatio.toFixed(3)}，似然提升=${layer.overdispersion.logLikImprovement.toFixed(2)}`
      : '—';
    lines.push(`- 层（${label}）：先验 Beta(alpha=${prior.alpha.toFixed(3)}, beta=${prior.beta.toFixed(3)})，mu=${prior.mu.toFixed(4)}，k=${prior.k.toFixed(3)}；状态 ${layer.status}（${boundary}）；${dispersion}`);
  }
  lines.push('');
  const excluded = points.filter(point => point.status === 'excluded_layer_without_prior');
  if (excluded.length > 0) {
    for (const point of excluded) {
      lines.push(`- 点 ${point.point}（${point.dimensions.region}/${point.dimensions.service}）：${point.note}，已排除出后验、排序与标准化。`);
    }
    lines.push('');
  }
  lines.push('标记约定：零尝试点只返回先验后验、无原始率；全成功点后验质量仍小于 1，可信区间上界不为 100%；重置期增量按重置后计数器重新起算并显式标记；小样本点保留在清单中但收缩向本层先验。');
  return lines.join('\n') + '\n';
}
