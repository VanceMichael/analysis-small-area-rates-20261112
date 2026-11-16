// 生成边界场景合成台账（本地合成数据，非外部输入）。
// 覆盖：修订选择、累计回退拒绝、reset 重新起账、全成功、零尝试、层内仅一点、层内无训练数据、
// 新点（无训练窗口）、as_of 之后的未来修订剔除。
import { writeFile, mkdir } from 'node:fs/promises';

let sequence = 0;
function row(point, region, service, period, success, attempts, asOf, revision, reset) {
  const id = `e${String(sequence).padStart(4, '0')}`;
  sequence += 1;
  return { id, point, region, service, period, success, attempts, as_of: asOf, revision, reset };
}

const records = [];

// A: north/card，期间 2 有修订（rev1 错值被 rev2 替代）；期间 4 reset 重新起账
records.push(row('A', 'north', 'card', 1, 5, 10, 2, 1, false));
records.push(row('A', 'north', 'card', 2, 9, 18, 3, 1, false));   // 旧修订，将被替代
records.push(row('A', 'north', 'card', 2, 10, 20, 4, 2, false));  // 合法修订：累计 10/20
records.push(row('A', 'north', 'card', 3, 14, 28, 5, 1, false));  // 增量 4/8
records.push(row('A', 'north', 'card', 4, 3, 6, 6, 1, true));     // 重置起账：增量 3/6
records.push(row('A', 'north', 'card', 5, 6, 12, 7, 1, false));  // 增量 3/6
records.push(row('A', 'north', 'card', 6, 9, 18, 8, 1, false));  // 增量 3/6
records.push(row('A', 'north', 'card', 7, 12, 24, 9, 1, false)); // 分析期增量 3/6
records.push(row('A', 'north', 'card', 8, 15, 30, 10, 1, false)); // 分析期增量 3/6
records.push(row('A', 'north', 'card', 8, 16, 32, 11, 2, false)); // 未来修订：as_of=11 截止 10 时剔除

// B: north/card，训练期全成功
records.push(row('B', 'north', 'card', 1, 8, 8, 2, 1, false));
records.push(row('B', 'north', 'card', 2, 16, 16, 3, 1, false));
records.push(row('B', 'north', 'card', 3, 24, 24, 4, 1, false));
records.push(row('B', 'north', 'card', 4, 32, 32, 5, 1, false));
records.push(row('B', 'north', 'card', 5, 40, 40, 6, 1, false));
records.push(row('B', 'north', 'card', 6, 48, 48, 7, 1, false));
records.push(row('B', 'north', 'card', 7, 52, 54, 8, 1, false)); // 分析期 4/6
records.push(row('B', 'north', 'card', 8, 56, 60, 9, 1, false)); // 分析期 4/6

// C: south/card，层内仅一点；期间 7 零尝试
records.push(row('C', 'south', 'card', 1, 2, 8, 2, 1, false));
records.push(row('C', 'south', 'card', 2, 5, 16, 3, 1, false));
records.push(row('C', 'south', 'card', 3, 9, 24, 4, 1, false));
records.push(row('C', 'south', 'card', 4, 12, 32, 5, 1, false));
records.push(row('C', 'south', 'card', 5, 16, 40, 6, 1, false));
records.push(row('C', 'south', 'card', 6, 20, 48, 7, 1, false));
records.push(row('C', 'south', 'card', 7, 20, 48, 8, 1, false)); // 零尝试期间，增量 0/0
records.push(row('C', 'south', 'card', 8, 24, 56, 9, 1, false)); // 分析期合计 4/8

// D: south/language，训练期零尝试 -> 先验不可用；分析期只有 2/2 的小样本
records.push(row('D', 'south', 'language', 1, 0, 0, 2, 1, false));
records.push(row('D', 'south', 'language', 2, 0, 0, 3, 1, false));
records.push(row('D', 'south', 'language', 3, 0, 0, 4, 1, false));
records.push(row('D', 'south', 'language', 4, 0, 0, 5, 1, false));
records.push(row('D', 'south', 'language', 5, 0, 0, 6, 1, false));
records.push(row('D', 'south', 'language', 6, 0, 0, 7, 1, false));
records.push(row('D', 'south', 'language', 7, 1, 1, 8, 1, false));
records.push(row('D', 'south', 'language', 8, 2, 2, 9, 1, false));

// E: north/language，训练期有数据的老点（保证该层可估计，且给 D 证明不跨层借先验）
records.push(row('E', 'north', 'language', 1, 4, 10, 2, 1, false));
records.push(row('E', 'north', 'language', 2, 9, 20, 3, 1, false));
records.push(row('E', 'north', 'language', 3, 14, 30, 4, 1, false));
records.push(row('E', 'north', 'language', 4, 19, 40, 5, 1, false));
records.push(row('E', 'north', 'language', 5, 24, 50, 6, 1, false));
records.push(row('E', 'north', 'language', 6, 30, 60, 7, 1, false));
records.push(row('E', 'north', 'language', 7, 35, 70, 8, 1, false)); // 分析期 5/10
records.push(row('E', 'north', 'language', 8, 40, 80, 9, 1, false)); // 分析期 5/10

// N: south/card 新点，训练窗口完全没有记录，仅分析期 2/2（“两笔成功排第一”的原型）
records.push(row('N', 'south', 'card', 7, 1, 1, 8, 1, false));
records.push(row('N', 'south', 'card', 8, 2, 2, 9, 1, false));

const document = { version: 1, records };
await mkdir('data', { recursive: true });
await writeFile('data/case-records.json', JSON.stringify(document, null, 2) + '\n');
console.log(`wrote ${records.length} rows to data/case-records.json`);
