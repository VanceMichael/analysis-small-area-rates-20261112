# small-area-rates

`success`/`attempts` 是会被修订的累计计数，基础台账仅展示每条上报，不做跨期相加推断。

项目提供本地记录校验、输入指纹和按 `service` 的原始核算，并在此之上实现 **Beta-Binomial 分层小域分析**：先按 `as_of` 选择合法修订、还原非重叠期间增量（重置显式标记），再用训练窗内按 `region × service` 共享的经验贝叶斯先验做共轭收缩，输出原始率、收缩后验、可信区间、阈值以下后验概率与排序不确定性，而不是一张按均值排好的榜。分析人员可以保留完整输入并复查每次导出的 JSON；原始数据不被命令改写。业务配置位于 `data/policy.json`，字段约定与方法口径见 `docs/data.md`。

## 运行

使用 Node.js 22 LTS（>=22.22.1 且 <23）和 npm，无第三方运行依赖。
`.nvmrc` 选择 22 主版本，清单与锁文件记录相同的兼容范围；Dockerfile 仍固定基础镜像摘要，容器构建可精确复现。

```sh
npm ci --ignore-scripts --no-audit --no-fund --offline
npm run build
npm test
npm run summary
node src/cli.js inspect --input data/records.json
node src/cli.js summary --input data/records.json --out var/summary.json
node src/cli.js analyze --out var/analysis.json
node src/cli.js report  --out var/report.json
npm run generate-data   # 幂等重建含边界场景的演练数据
npm run demo
```

`npm run demo` 在本地打印输入、现有核算、Beta-Binomial 分析摘要并生成 `var/summary.json`、`var/analysis.json`、`var/report.json` 与运营复核清单 `var/resource-review.md`，不访问网络、不等待真实业务时间，通常几秒内完成。输出目录可删除后重新运行，测试只使用临时目录。

## 批次更新与撤回

```sh
node src/cli.js update   --state var/state.json --batch batch.json --batch-id B1
node src/cli.js withdraw --state var/state.json --batch-id B1
```

每批只能登记一次；状态文件保存训练窗口、先验配置与更新日志，撤回后可用剩余原始记录重建后验。`as_of` 晚于分析时点的修订对当前分析不可见，追加未来数据不会反改过去分析。

## 容器

```sh
docker build -t small-area-rates:local .
docker run --rm --network none small-area-rates:local
```

Dockerfile 固定 Node.js 基础镜像摘要，构建时执行语法检查和测试。镜像构建完成后演示无需联网；可覆盖命令运行 `npm test`。构建不需要真实账号、邮件服务、数据库或线上数据。

## 目录

- `src/dataset.js`：记录校验、规范序列化和数据指纹。
- `src/domain.js`：当前业务分组核算。
- `src/ledger.js`：合法修订选择、非重叠期间增量重建与重置标记。
- `src/beta.js`：Beta 分布数值（gamma、CDF、分位数、共轭更新、抽样）。
- `src/prior.js`：分层 Beta-Binomial 先验 MLE、边界解与过度离散诊断。
- `src/model.js`：后验、阈值概率、排序不确定性与固定结构标准化。
- `src/updates.js`：批次更新状态机与撤回重建。
- `src/report.js`：带不确定性说明的运营资源复核清单。
- `src/cli.js`：本地读取、检查和导出入口。
- `src/output.js`：以临时文件写入后替换完整 JSON。
- `test/`：输入约束、台账、先验、后验、更新、报告与命令回归。
- `data/`：合成记录、独立核对值及本地业务配置。
