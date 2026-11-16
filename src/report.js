// 把复核结果渲染成运营可读的 Markdown 清单：不做均值排行榜，
// 以阈值后验概率的决策分组呈现，并随附排序不确定性与固定结构标准化说明。

function pct(value, digits = 1) {
  return value == null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function num(value, digits = 3) {
  return value == null ? '—' : value.toFixed(digits);
}

const ACTION_TITLE = {
  'adjust-resource': '一、建议调整资源（低于阈值的后验概率高）',
  watch: '二、观察名单（证据不足以下结论）',
  hold: '三、维持现状（低于阈值证据弱）',
  'data-gap': '四、数据缺口（先验不可用，不做贝叶斯结论）'
};

const ACTION_ORDER = ['adjust-resource', 'watch', 'hold', 'data-gap'];

export function renderReviewMarkdown(report, policy) {
  const lines = [];
  const { run } = report;
  lines.push('# 外卡服务点资源复核清单');
  lines.push('');
  lines.push(`- 数据截止 as_of：${run.asOf}；训练窗口：period <= ${run.trainThrough}（先验仅由该窗口估计，已封存）`);
  lines.push(`- 业务阈值：${pct(run.threshold)}；可信水平：${pct(run.credibleLevel, 0)}；分层：${run.poolBy.join(' × ')}`);
  lines.push(`- 输入指纹：\`${run.inputFingerprint.slice(0, 16)}…\`；结果指纹：\`${report.canonicalFingerprint.slice(0, 16)}…\``);
  lines.push('');
  const audit = report.ledgerAudit;
  lines.push('## 台账合规审计');
  lines.push('');
  lines.push(`- 输入记录 ${audit.inputRecords} 条；因 as_of 晚于截止剔除 ${audit.droppedAsFuture.length} 条；被更新修订替代 ${audit.superseded.length} 条；显式重置 ${audit.resetCount} 处。`);
  if (audit.droppedAsFuture.length > 0) lines.push(`- 剔除记录：${audit.droppedAsFuture.join(', ')}`);
  for (const item of audit.superseded) {
    lines.push(`- 点 ${item.point} 期间 ${item.period}：保留 \`${item.keptId}\`，替代旧修订 \`${item.replacedId}\``);
  }
  for (const item of audit.resets) {
    lines.push(`- 点 ${item.point} 期间 ${item.period}：reset=true 重新起账，重置前累计 ${item.priorCumulativeSuccess}/${item.priorCumulativeAttempts} 不与新账相加`);
  }
  lines.push('');
  lines.push('## 各点推断（按点标识排列，非排行榜）');
  lines.push('');
  lines.push('| 点 | 层 | 分析期 成功/尝试 | 原始率 | 收缩后验均值 | 90% 可信区间 | P(率<阈值) | 决策 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const item of report.points) {
    const interval = item.posterior.credible
      ? `${num(item.posterior.credible.lower)}–${num(item.posterior.credible.upper)}` : '—';
    lines.push(`| ${item.point} | ${item.layerKey} | ${item.analysisWindow.success}/${item.analysisWindow.attempts} | ${num(item.rawRate)} | ${num(item.posterior.mean)} | ${interval} | ${pct(item.probabilityBelowThreshold)} | ${item.decision} |`);
  }
  lines.push('');
  for (const action of ACTION_ORDER) {
    const members = report.points.filter(item => item.decision === action);
    if (members.length === 0) continue;
    lines.push(`### ${ACTION_TITLE[action]}`);
    lines.push('');
    for (const item of members) {
      const rank = report.ranking.rankings.find(entry => entry.point === item.point);
      const topOne = rank ? rank.topK[0].probability : null;
      const rankText = rank
        ? `期望名次 ${rank.expectedRank.toFixed(1)}，拿第一概率 ${pct(topOne)}（MC 标准误 ±${pct(rank.topK[0].standardError, 2)}，${report.ranking.draws} 次抽样）`
        : '不参与排序（先验不可用）';
      lines.push(`- **${item.point}**（${item.layerKey}）：分析期 ${item.analysisWindow.success}/${item.analysisWindow.attempts}，原始率 ${num(item.rawRate)}，后验均值 ${num(item.posterior.mean)}，P(率<${policy.threshold})=${pct(item.probabilityBelowThreshold)}。${item.decisionReason}。${rankText}。`);
      if (item.resetPeriods.length > 0) lines.push(`  - 台账在期间 ${item.resetPeriods.join(', ')} 发生重置，增量已分段还原。`);
    }
    lines.push('');
  }
  lines.push('## 排序不确定性（为什么没有冠军）');
  lines.push('');
  lines.push('名次由后验联合抽样得到，下表给出每个点进入前 k 名的概率；概率接近 50% 意味着排序位置基本不可靠。');
  lines.push('');
  const header = report.ranking.rankings.length > 0 ? ['点', ...report.ranking.rankings[0].topK.map(cell => `前${cell.k}`)] : [];
  if (header.length > 0) {
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const entry of report.ranking.rankings) {
      lines.push(`| ${entry.point} | ${entry.topK.map(cell => pct(cell.probability)).join(' | ')} |`);
    }
    lines.push('');
  }
  for (const item of report.ranking.unavailable) {
    lines.push(`- ${item.point}：${item.reason}，不参与跨点排序。`);
  }
  if (report.ranking.unavailable.length > 0) lines.push('');
  lines.push('## 层先验与过度离散（可查口径）');
  lines.push('');
  lines.push('| 层 | 训练尝试 | 原始池化率 | 调整后 μ | 集中参数 M | 组内相关 1/(M+1) | 边界标记 |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const prior of report.layerPriors) {
    lines.push(`| ${prior.layerKey} | ${prior.trainingAttempts} | ${num(prior.pooledRateRaw)} | ${num(prior.pooledRateAdjusted)} | ${num(prior.concentration, 1)} | ${num(prior.intraClassCorrelation, 4)} | ${prior.flags.join('；') || '内点解'} |`);
  }
  lines.push('');
  lines.push('## 固定业务结构标准化（跨层资源视角）');
  lines.push('');
  const std = report.standardization;
  if (std.status === 'unavailable') {
    lines.push(`标准化不可用：${std.missingLayers.map(item => item.layerKey).join(', ')} 层没有可估计先验。`);
  } else {
    lines.push(`- 固定结构标准化率（后验均值）：**${num(std.standardizedRate.mean)}**，${pct(std.standardizedRate.credible.level, 0)} 可信区间 ${num(std.standardizedRate.credible.lower)}–${num(std.standardizedRate.credible.upper)}，标准差 ${num(std.standardizedRate.stdDev, 4)}`);
    lines.push(`- 全体交易总体粗率（按实际尝试量加权）：**${num(std.crudePooledRate)}**（${std.crudePooled.success}/${std.crudePooled.attempts}）`);
    lines.push(`- 两者不相等是口径差异：标准化率用与交易量无关的固定层权重 ${JSON.stringify(std.weights)}，让小层不被交易量淹没；总体粗率按各层实际尝试占比 ${JSON.stringify(Object.fromEntries(Object.entries(std.volumeWeights).map(([k, v]) => [k, Number(v.toFixed(3))])))} 加权，回答的是“单笔交易平均成功率”，不能替代固定结构比较。`);
    if (std.status === 'partial') lines.push(`- 部分层先验不可用，标准化仅覆盖：${std.layers.map(item => item.layerKey).join(', ')}`);
  }
  lines.push('');
  lines.push('## 方法学与复核说明');
  lines.push('');
  lines.push('- 先验在 region × service 层内共享，超参数只由封存训练窗口的点级矩估计得到；没有训练数据的层标记为 unavailable，不借用全局先验。');
  lines.push('- 后验为 Beta 共轭更新，已逐点用先验参数加分析期计数手算核对（见 JSON 的 conjugateCheck，全部通过）。');
  lines.push('- 阈值概率来自正则化不完全 Beta 的精确分布；排序概率来自确定性随机种子的蒙特卡洛并附标准误，复跑结果一致。');
  lines.push('- success/attempts 为累计台账，本报告只使用还原后的非重叠期间增量；累计值从不跨期相加，重置点按 reset 标记分段起账。');
  lines.push('- 小样本点不会被删除：它们的原始率照实展示，收缩估计自动靠向层均值，宽可信区间与低名次置信度会如实呈现，两笔成功不足以得到确定的冠军。');
  lines.push('');
  return lines.join('\n');
}
