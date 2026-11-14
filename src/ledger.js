// 累计台账处理：success/attempts 是会被修订的累计计数器，不可直接跨行相加。
// 1) 按 as_of 选择截至分析时点仍然合法的最新修订；
// 2) 在每个 point 内按 period 还原互不重叠的期间增量；
// 3) reset=true 表示计数器在该期重置，该期增量等于当期台账值，并有显式标记。

import { validateRecords } from './dataset.js';

// 同一 (point, period) 的多次上报：只保留 as_of <= asOf 且修订号最大的一条。
// 未来时点的修订对当前分析不可见；相同 (as_of, revision) 的冲突值直接拒绝。
export function selectLegalRevisions(records, asOf) {
  validateRecords(records);
  if (!Number.isSafeInteger(asOf)) throw new Error('asOf 必须为安全整数');
  const chosen = new Map();
  const superseded = [];
  const future = [];
  for (const record of records) {
    const key = `${record.point}\u0000${record.period}`;
    if (record.as_of > asOf) {
      future.push(record.id);
      continue;
    }
    const current = chosen.get(key);
    if (!current) {
      chosen.set(key, record);
      continue;
    }
    if (current.as_of === record.as_of && current.revision === record.revision
      && (current.success !== record.success || current.attempts !== record.attempts
        || current.reset !== record.reset)) {
      throw new Error(`点 ${record.point} 期 ${record.period} 存在同修订号但内容冲突的上报`);
    }
    if (record.revision > current.revision
      || (record.revision === current.revision && record.as_of > current.as_of)) {
      superseded.push(current.id);
      chosen.set(key, record);
    } else {
      superseded.push(record.id);
    }
  }
  const legal = [...chosen.values()]
    .sort((left, right) => left.point.localeCompare(right.point, 'en')
      || left.period - right.period
      || left.id.localeCompare(right.id, 'en'));
  return {
    legal,
    superseded: [...new Set(superseded)].sort(),
    future: [...new Set(future)].sort(),
  };
}

function checkMonotonic(label, previous, current, point, period) {
  if (current < previous) {
    throw new Error(`${label} 在点 ${point} 期 ${period} 出现累计回退（${previous} -> ${current}），应以 reset 显式标记重置`);
  }
}

// 对单个点按 period 排序，重建逐期增量。
// 普通行：增量 = 本期累计 - 上期累计；reset 行：增量 = 本期累计（计数器重新开始）。
export function reconstructPoint(rows) {
  const ordered = [...rows].sort((left, right) => left.period - right.period
    || left.revision - right.revision);
  const increments = [];
  let previous = null;
  for (const row of ordered) {
    if (row.success < 0 || row.attempts < 0 || row.success > row.attempts) {
      throw new Error(`点 ${row.point} 期 ${row.period} 的成功/尝试计数不合法`);
    }
    let successDelta;
    let attemptsDelta;
    let reset = row.reset === true;
    if (previous === null || reset) {
      successDelta = row.success;
      attemptsDelta = row.attempts;
    } else {
      checkMonotonic('success', previous.success, row.success, row.point, row.period);
      checkMonotonic('attempts', previous.attempts, row.attempts, row.point, row.period);
      successDelta = row.success - previous.success;
      attemptsDelta = row.attempts - previous.attempts;
      if (successDelta > attemptsDelta) {
        throw new Error(`点 ${row.point} 期 ${row.period} 的成功增量超过尝试增量`);
      }
    }
    increments.push({
      point: row.point,
      region: row.region,
      service: row.service,
      period: row.period,
      successDelta,
      attemptsDelta,
      reset,
      cumulativeSuccess: row.success,
      cumulativeAttempts: row.attempts,
      asOf: row.as_of,
      revision: row.revision,
      sourceId: row.id,
    });
    previous = row;
  }
  return increments;
}

export function reconstructLedger(records, asOf) {
  const { legal, superseded, future } = selectLegalRevisions(records, asOf);
  const byPoint = new Map();
  for (const row of legal) {
    if (!byPoint.has(row.point)) byPoint.set(row.point, []);
    byPoint.get(row.point).push(row);
  }
  const points = [...byPoint.keys()].sort((left, right) => left.localeCompare(right, 'en'));
  const increments = [];
  const resetPeriods = [];
  for (const point of points) {
    const rows = byPoint.get(point);
    const pointIncrements = reconstructPoint(rows);
    increments.push(...pointIncrements);
    for (const item of pointIncrements) {
      if (item.reset) resetPeriods.push({ point: item.point, period: item.period, sourceId: item.sourceId });
    }
  }
  // 守恒核对：非重置段内增量合计应等于段末累计值。
  for (const point of points) {
    const rows = byPoint.get(point).sort((left, right) => left.period - right.period);
    const pointIncrements = increments.filter(item => item.point === point);
    let successSum = 0;
    let attemptsSum = 0;
    let last = null;
    for (const row of rows) {
      if (row.reset) {
        successSum = 0;
        attemptsSum = 0;
      }
      const segment = pointIncrements.find(item => item.period === row.period);
      successSum += segment.successDelta;
      attemptsSum += segment.attemptsDelta;
      if (successSum !== row.success || attemptsSum !== row.attempts) {
        throw new Error(`点 ${point} 期 ${row.period} 的增量守恒核对失败`);
      }
      last = row;
    }
    void last;
  }
  return {
    asOf,
    legal,
    increments: increments.sort((left, right) => left.point.localeCompare(right.point, 'en')
      || left.period - right.period),
    resets: resetPeriods,
    superseded,
    future,
  };
}
