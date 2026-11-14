import { main } from '../src/cli.js';
import { readFile, writeFile } from 'node:fs/promises';

const started = performance.now();
console.log('读取本地演练记录并核对输入指纹');
console.log(JSON.stringify(await main(['inspect']), null, 2));
console.log('现有领域核算（累计台账逐行清点，不做跨期相加）');
console.log(JSON.stringify(await main(['summary', '--out', 'var/summary.json']), null, 2));
console.log('业务配置');
console.log(JSON.stringify(JSON.parse(await readFile('data/policy.json', 'utf8')), null, 2));
console.log('Beta-Binomial 分层分析（训练窗先验、收缩后验、阈值概率与排序不确定性）');
const analysis = await main(['analyze', '--out', 'var/analysis.json']);
console.log(JSON.stringify({
  asOf: analysis.asOf,
  ledger: {
    legalRecordCount: analysis.ledger.legalRecordCount,
    supersededRecordIds: analysis.ledger.supersededRecordIds,
    futureRecordIds: analysis.ledger.futureRecordIds,
    resets: analysis.ledger.resets,
  },
  priors: analysis.priors.layers.map(layer => ({
    layer: layer.dimensions,
    status: layer.status,
    prior: layer.prior && { mu: layer.prior.mu, k: layer.prior.k },
  })),
  pointCount: analysis.analysis.points.length,
}, null, 2));
console.log('生成运营资源复核清单（Markdown）');
const report = await main(['report', '--out', 'var/report.json']);
await writeFile('var/resource-review.md', report.report);
console.log('已写出 var/resource-review.md');
console.log(`完成，用时 ${Math.ceil(performance.now() - started)} 毫秒`);
