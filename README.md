# small-area-rates

success/attempts 是会被更正的累计计数台账：基础台账仅展示每条上报，不做跨期累计值相加。分析命令先按 `as_of` 选择合法修订、按 `reset` 标记分段，再还原互不重叠的期间增量。

项目在本地记录校验、输入指纹和按 `service` 的原始核算之外，提供 Beta-Binomial 分层小域分析：层共享先验、共轭后验、阈值以下后验概率、排序不确定性，以及固定业务结构的跨层标准化。业务配置位于 `data/policy.json`（版本 2），字段与方法学约定在 `docs/data.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
npm run review
npm run demo
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js review --input data/records.json --policy data/policy.json \
  --out var/review.json --markdown var/review.md
```

`npm run review` 输出 JSON 复核结果与运营 Markdown 清单；`npm run demo` 额外跑 `data/case-records.json` 的边界场景（修订、重置、全成功、零尝试、层内仅一点、层内无训练数据、新点、未来修订）。全部流程不访问网络，输出目录可删除后重跑，测试只使用临时目录。

## 更新日志（每批只更新一次，撤回可重建）

```sh
node src/cli.js journal-init --input data/records.json --policy data/policy.json --journal var/journal.json
node src/cli.js journal-add --input batch.json --journal var/journal.json --batch-id b-2026-01
node src/cli.js journal-withdraw --journal var/journal.json --batch-id b-2026-01
node src/cli.js journal-rebuild --policy data/policy.json --journal var/journal.json \
  --out var/rebuilt.json --markdown var/rebuilt.md
```

训练窗口在 `journal-init` 时封存，之后到达的训练期记录一律拒绝；批次号或记录指纹重复会报错；撤回保留痕迹，重放只含有效批次。

## 容器

```sh
docker build -t small-area-rates:local .
docker run --rm --network none small-area-rates:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算（逐行清点，不做推断）。
- `src/ledger.js`：合法修订选择、重置识别与非重叠期间增量还原。
- `src/beta.js`：lgamma、正则化不完全 Beta 及其逆、Beta-Binomial 质量函数、确定性随机流与 Beta 抽样。
- `src/prior.js`：层共享先验矩估计（边界解/过度离散可查）与共轭后验更新。
- `src/simulate.js`：精确阈值概率、可信区间与蒙特卡洛排序不确定性（含标准误）。
- `src/standardize.js`：固定业务结构标准化及与交易量加权粗率的对照。
- `src/journal.js`：训练窗口封存、批次幂等更新、撤回与重放重建。
- `src/policy.js`：版本 2 策略加载与固定权重解析。
- `src/review.js` / `src/report.js`：复核主流程与运营 Markdown 清单。
- `src/cli.js` / `src/output.js`：本地命令入口与原子化 JSON/文本写入。
- `test/`：数值、台账、先验、排序、标准化、日志与端到端回归（58 个测试）。
- `data/`：合成记录、边界场景记录、独立核对值及业务配置。
