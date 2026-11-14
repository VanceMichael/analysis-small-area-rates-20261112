# 数据与分析口径

`success`/`attempts` 是**会被修订的累计计数器**，不是逐期流量。任何分析都不直接把累计行相加，而是先恢复合法修订与非重叠期间增量。

## 数据文件

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。它由 `scripts/generate-data.js` 幂等生成（两次运行逐字节一致），包含基础面板和九类边界场景：历史更正、台账重置、零尝试点、训练窗后新点、低成功率异质点、无训练数据层、新开小点、同质点层与未来修订。`id` 是导入记录键，不得重复；数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于未公开标签，不用零冒充缺测。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `id` | `string` | 导入记录键，全局唯一 |
| `point` | `string` | 服务点 |
| `region` | `string` | 区域分层字段 |
| `service` | `string` | 业务分层字段 |
| `period` | `integer` | 业务期间 |
| `success` | `integer` | 截至该期的累计成功数 |
| `attempts` | `integer` | 截至该期的累计尝试数 |
| `as_of` | `integer` | 上报生效时点 |
| `revision` | `integer` | 同一点同一期的修订号 |
| `reset` | `boolean` | 计数器是否在该期重置 |

## 台账处理（`src/ledger.js`）

1. **合法修订选择**：对每个 `(point, period)`，只保留 `as_of <= asOf` 且 `revision` 最大的上报。`as_of` 晚于分析时点的修订对当前分析不可见（计入 `futureRecordIds`），因此追加未来数据不会反改过去分析。同修订号同 `as_of` 但内容冲突直接报错。
2. **非重叠增量**：点内按期排序，普通行增量为本期累计减上期累计；累计回退而未标 `reset` 会被拒绝。
3. **重置标记**：`reset=true` 时该期增量等于重置后的台账值，并在输出 `resets` 与点级 `resetPeriods` 中显式标记。
4. 重建后做增量守恒核对：非重置段增量合计必须等于段末累计值。

## 分层先验（`src/prior.js`）

- 先验在 `poolBy`（默认 `region × service`）定义的**每一层内共享**，只由训练窗口 `period <= trainThrough` 的增量估计，窗外观测不进入超参数。
- 模型为 Beta-Binomial，参数化 `mu = alpha/(alpha+beta)`、`k = alpha+beta`；矩估计给初值，坐标上升 + 黄金分割求极大似然。
- 估计目标、收敛迭代数、矩估计初值、边界解、对数似然与过度离散诊断（ICC、经验/二项方差比、相对二项模型的似然提升）全部写入输出。
- 边界情形显式处理：同质层浓度撞上界、层内仅一点时浓度不可识别（用显式保守 `k=2` 并说明）、训练窗无数据的层返回 `null` 先验。**没有数据的层不会偷偷借用全局或其他层先验**，其点被排除出后验、排序与标准化。

## 后验与决策量（`src/model.js`、`src/beta.js`）

- 共轭更新 `Beta(alpha,beta) + (success,attempts) → Beta(alpha+success, beta+attempts-success)`。Beta 的 CDF、分位数与抽样均为无第三方依赖的手算实现（Lanczos gamma、Lentz 连分式、二分求逆、Marsaglia–Tsang 抽样）。
- 每个点给出：原始率、收缩后验均值、95% 可信区间、数据权重 `attempts/(k+attempts)`、**阈值以下后验概率 `P(theta < threshold)`**（解析 CDF，不靠模拟）。
- **排序不确定性**用固定种子蒙特卡洛（默认 10000 次，种子可复算）给出后验名次中位数、名次 95% 区间、夺冠概率、前三概率与层内夺冠概率。两笔全成的小点原始率 100%，但后验均值与可信区间上界都小于 1，不会得到确定冠军。
- 零尝试点无原始率，后验即先验，仍保留在清单中；全成功点后验质量小于 1。

## 标准化（跨层资源比较）

`standardization` 按 `policy.json` 的**固定业务结构** `standardWeights` 对各层后验均值加权，回答“结构不变时服务表现如何”。它**不等于全体交易的总体率**：总体率是全部成功除以全部尝试，混合了各层交易量结构，会被大层和交易量波动主导。缺先验的层不重新归一化，而是以 `includedWeight` 显式暴露覆盖缺口。

## 更新与撤回（`src/updates.js`）

- 每批记录只能登记一次（`batchId` 唯一、记录 `id` 全局唯一）；历史更应用新 `id`、更高 `revision` 的新记录进入。
- 状态文件同时保存训练窗口、先验配置与更新日志。撤回某批后，用剩余原始记录即可完整重建台账、先验与后验。

## 命令

```sh
node src/cli.js inspect                       # 行数、字段、输入指纹
node src/cli.js summary                       # 既有逐行清点（不做推断）
node src/cli.js analyze --out var/a.json      # 完整 Beta-Binomial 分析
node src/cli.js report  --out var/r.json      # 分析 + Markdown 复核清单
node src/cli.js update   --state s.json --batch b.json --batch-id B1
node src/cli.js withdraw --state s.json --batch-id B1
# 可选：--policy、--as-of、--seed、--draws、--input、--out
```

错误发生时命令返回非零退出码；数据版本不支持时直接拒绝，不做静默迁移。
