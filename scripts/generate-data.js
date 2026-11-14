// 演练数据生成器（幂等）：完整重建基础面板与修订、重置、零尝试、新点、无先验层等场景。
// 基础面板：12 个点 × period 1-8，success/attempts 为严格累计台账，数值与原始演练数据一致。
// 用法：node scripts/generate-data.js
import { writeFile } from 'node:fs/promises';

const records = [];
let counter = 0;
const nextId = () => `r${String(counter++).padStart(4, '0')}`;
const base = (point, region, service, period, success, attempts, extra = {}) => records.push({
  point, region, service, period, success, attempts,
  as_of: period + 1, revision: 1, reset: false, id: nextId(), ...extra,
});
const cumulative = (point, region, service, periods, rate) => {
  let success = 0;
  let attempts = 0;
  for (const period of periods) {
    attempts += rate.attempts(period);
    success += rate.success(period);
    base(point, region, service, period, success, attempts);
  }
};

// ---- 基础面板：点 p_i 每期增量尝试 i+3、增量成功 i+1（期优先排列，与原始演练台账逐行一致）----
const pointIndexOf = Object.fromEntries([...Array(12).keys()].map(i => {
  const point = `p${i}`;
  return [point, {
    index: i,
    region: i % 2 === 0 ? 'north' : 'south',
    service: i % 4 < 2 ? 'card' : 'language',
  }];
}));
for (const period of [1, 2, 3, 4, 5, 6, 7, 8]) {
  for (const pointIndex of [...Array(12).keys()]) {
    const point = `p${pointIndex}`;
    const { region, service } = pointIndexOf[point];
    const attempts = period * (pointIndex + 3);
    const success = period * (pointIndex + 1);
    base(point, region, service, period, success, attempts);
  }
}

// ---- 场景 1：历史更正（同一 period 更高 revision，旧行应被替代）----
base('p0', 'north', 'card', 1, 2, 4, { as_of: 2, revision: 2 });

// ---- 场景 2：重置点 p12（north/card），期 5 台账归零重起 ----
{
  const rows = [[2, 2, 4], [3, 4, 8], [4, 5, 11]];
  for (const [period, success, attempts] of rows) base('p12', 'north', 'card', period, success, attempts);
  base('p12', 'north', 'card', 5, 3, 5, { reset: true });
  let success = 3;
  let attempts = 5;
  for (const [period, dS, dA] of [[6, 3, 4], [7, 3, 4], [8, 2, 4]]) {
    success += dS;
    attempts += dA;
    base('p12', 'north', 'card', period, success, attempts);
  }
}

// ---- 场景 3：零尝试点 p13（south/card），训练窗无交易、期 7 起才有数据 ----
for (const period of [2, 3, 4, 5, 6]) base('p13', 'south', 'card', period, 0, 0);
base('p13', 'south', 'card', 7, 1, 2);
base('p13', 'south', 'card', 8, 2, 5);

// ---- 场景 4：训练窗后新点 p14（south/card），大样本高成功率 ----
base('p14', 'south', 'card', 7, 46, 50);
base('p14', 'south', 'card', 8, 94, 100);

// ---- 场景 5：低成功率点 p15（north/card），制造可识别的过度离散 ----
cumulative('p15', 'north', 'card', [1, 2, 3, 4, 5, 6, 7, 8], { attempts: () => 8, success: () => 1 });

// ---- 场景 6：无训练数据层 p16（east/card），期 7 才出现，禁止借全局先验 ----
base('p16', 'east', 'card', 7, 5, 8);
base('p16', 'east', 'card', 8, 10, 16);

// ---- 场景 7：新开小点 p17（north/card），两笔全成，不应得到确定冠军 ----
base('p17', 'north', 'card', 7, 2, 2);
base('p17', 'north', 'card', 8, 3, 4);

// ---- 场景 8：两个 language 层各加低成功率点，使训练窗过度离散可识别 ----
cumulative('p18', 'north', 'language', [1, 2, 3, 4, 5, 6, 7, 8], { attempts: () => 6, success: () => 1 });
cumulative('p19', 'south', 'language', [1, 2, 3, 4, 5, 6, 7, 8], { attempts: () => 6, success: () => 1 });

// ---- 场景 8b：south/card 训练窗异质点，使该层浓度同样可识别 ----
cumulative('p20', 'south', 'card', [1, 2, 3, 4, 5, 6, 7, 8], { attempts: () => 8, success: () => 1 });

// ---- 场景 9：未来修订（as_of=11 > asOf=10），本次分析不可见，追加不反改过去 ----
base('p0', 'north', 'card', 8, 99, 100, { as_of: 11, revision: 9, reset: true });

await writeFile('data/records.json', JSON.stringify({ version: 1, records }, null, 2) + '\n');
console.log(`generated ${records.length} records`);
