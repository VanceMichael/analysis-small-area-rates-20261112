// 累计台账重建：按 as_of 选择合法修订，还原互不重叠的期间增量。
// success/attempts 是累计计数，任何输出都不做跨期累计值相加；重置必须显式标记。

import { validateRecords } from './dataset.js';

const INTEGER_FIELDS = ['period', 'success', 'attempts', 'as_of', 'revision'];

function assertValidRows(records) {
  validateRecords(records);
  for (const [index, row] of records.entries()) {
    for (const field of INTEGER_FIELDS) {
      if (row[field] < 0) throw new Error(`第 ${index + 1} 条记录的 ${field} 不得为负`);
    }
    if (row.success > row.attempts) {
      throw new Error(`记录 ${row.id} 的 success 大于 attempts，累计台账不合法`);
    }
  }
}

// 仅保留 as_of <= cutoff 的合法修订；同一 point+period 取 revision 最大者。
// 返回每个点的期间序列（按 period 排序）以及审计信息（剔除/替代记录）。
export function selectLegalRevisions(records, asOf) {
  if (!Number.isSafeInteger(asOf) || asOf < 0) throw new Error('as_of 截止值必须是非负整数');
  const points = new Map();
  const droppedAsFuture = [];
  const superseded = [];
  for (const row of records) {
    if (row.as_of > asOf) {
      droppedAsFuture.push(row.id);
      continue;
    }
    if (!points.has(row.point)) points.set(row.point, new Map());
    const periods = points.get(row.point);
    if (!periods.has(row.period)) {
      periods.set(row.period, row);
    } else {
      const current = periods.get(row.period);
      if (row.revision > current.revision) {
        superseded.push({ point: row.point, period: row.period, replacedId: current.id, keptId: row.id });
        periods.set(row.period, row);
      } else if (row.revision < current.revision) {
        superseded.push({ point: row.point, period: row.period, replacedId: row.id, keptId: current.id });
      } else {
        throw new Error(`点 ${row.point} 期间 ${row.period} 存在 revision=${row.revision} 的重复上报（${row.id} 与 ${current.id}），无法选择合法修订`);
      }
    }
  }
  const series = new Map();
  for (const [point, periods] of points) {
    series.set(point, [...periods.values()].sort((a, b) => a.period - b.period));
  }
  return { series, droppedAsFuture: droppedAsFuture.sort(), superseded };
}

// 把累计快照序列还原为期间增量。reset=true 的期间重新起账，增量取其自身累计值。
export function reconstructPoint(point, rows) {
  const increments = [];
  const resets = [];
  let previous = null;
  for (const row of rows) {
    const base = { point, period: row.period, id: row.id, region: row.region, service: row.service,
      asOf: row.as_of, revision: row.revision, reset: row.reset };
    if (row.reset) {
      resets.push({ point, period: row.period, id: row.id, priorCumulativeSuccess: previous ? previous.success : null,
        priorCumulativeAttempts: previous ? previous.attempts : null });
      increments.push({ ...base, deltaSuccess: row.success, deltaAttempts: row.attempts, startFresh: true });
    } else {
      if (previous && !previous.reset) {
        const deltaSuccess = row.success - previous.success;
        const deltaAttempts = row.attempts - previous.attempts;
        if (deltaSuccess < 0 || deltaAttempts < 0) {
          throw new Error(`点 ${point} 期间 ${row.period} 出现累计值回退（success ${previous.success}->${row.success}，attempts ${previous.attempts}->${row.attempts}）；如重新起账必须显式 reset=true`);
        }
        increments.push({ ...base, deltaSuccess, deltaAttempts, startFresh: false });
      } else if (previous && previous.reset) {
        // 紧接 reset 之后的正常期间：与重置后的新账做差，不重新起账
        const deltaSuccess = row.success - previous.success;
        const deltaAttempts = row.attempts - previous.attempts;
        if (deltaSuccess < 0 || deltaAttempts < 0) {
          throw new Error(`点 ${point} 期间 ${row.period} 在重置后出现累计值回退（success ${previous.success}->${row.success}，attempts ${previous.attempts}->${row.attempts}）`);
        }
        increments.push({ ...base, deltaSuccess, deltaAttempts, startFresh: false });
      } else {
        // 首条快照即视为该点起点
        increments.push({ ...base, deltaSuccess: row.success, deltaAttempts: row.attempts, startFresh: true });
      }
    }
    previous = row;
  }
  return { increments, resets };
}

// 全量重建：返回每点增量、重置标记、分层元数据与审计清单。
export function reconstructLedger(records, asOf) {
  assertValidRows(records);
  const { series, droppedAsFuture, superseded } = selectLegalRevisions(records, asOf);
  const points = [];
  for (const [point, rows] of [...series.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    const metadata = rows[0];
    for (const row of rows) {
      if (row.region !== metadata.region || row.service !== metadata.service) {
        throw new Error(`点 ${point} 的 region/service 在期间之间发生变化，分层口径不稳定`);
      }
    }
    const { increments, resets } = reconstructPoint(point, rows);
    const totals = increments.reduce((acc, item) =>
      ({ success: acc.success + item.deltaSuccess, attempts: acc.attempts + item.deltaAttempts }),
      { success: 0, attempts: 0 });
    points.push({ point, region: metadata.region, service: metadata.service,
      layerKey: `${metadata.region}/${metadata.service}`, increments, resets, totals });
  }
  return {
    asOf,
    points,
    audit: {
      inputRecords: records.length,
      droppedAsFuture,
      superseded,
      resetCount: points.reduce((sum, item) => sum + item.resets.length, 0),
      resets: points.flatMap(item => item.resets)
    }
  };
}

// 按期间边界切分窗口（边界含 trainThrough）。
export function splitWindow(point, trainThrough) {
  const pick = range => range.reduce((acc, item) =>
    ({ success: acc.success + item.deltaSuccess, attempts: acc.attempts + item.deltaAttempts }),
    { success: 0, attempts: 0 });
  const training = point.increments.filter(item => item.period <= trainThrough);
  const analysis = point.increments.filter(item => item.period > trainThrough);
  return {
    training: pick(training),
    analysis: pick(analysis),
    trainingPeriods: [...new Set(training.map(item => item.period))].sort((a, b) => a - b),
    analysisPeriods: [...new Set(analysis.map(item => item.period))].sort((a, b) => a - b)
  };
}
