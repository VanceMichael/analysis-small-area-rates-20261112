import { main } from '../src/cli.js';
import { readFile } from 'node:fs/promises';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify(await main(['inspect']), null, 2));
console.log('现有领域核算（累计台账逐行核对，不做跨期相加）');
console.log(JSON.stringify(await main(['summary', '--out', 'var/summary.json']), null, 2));
console.log('Beta-Binomial 资源复核（主演练数据）');
console.log(JSON.stringify(await main(['review', '--out', 'var/review.json', '--markdown', 'var/review.md']), null, 2));
console.log('边界场景复核（修订/重置/全成功/零尝试/单点层/无训练层/新点）');
console.log(JSON.stringify(await main([
  'review',
  '--input', 'data/case-records.json',
  '--policy', 'data/case-policy.json',
  '--out', 'var/case-review.json',
  '--markdown', 'var/case-review.md'
]), null, 2));
console.log('业务配置');
console.log(JSON.stringify(JSON.parse(await readFile('data/policy.json', 'utf8')), null, 2));
console.log(`完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
