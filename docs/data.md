# 数据与分析口径

success/attempts 是会被更正的**累计计数台账**，不是期间计数。任何分析都不做跨期累计值相加；先按 `as_of` 选定合法修订，再还原互不重叠的期间增量。

## 记录字段

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。`id` 是导入记录键，不自动代表企业、访问或其他统计单位；记录键不得重复。数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于字段约定允许的未公开标签，不用零冒充缺测。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 导入记录键，全表唯一 |
| `point` | `string` | 服务点标识，分层与排序的稳定单位 |
| `region` | `string` | 区域，期间之间不得漂移 |
| `service` | `string` | 业务线，期间之间不得漂移 |
| `period` | `integer` | 业务期间序号 |
| `success` | `integer` | 截至该期间的累计成功数 |
| `attempts` | `integer` | 截至该期间的累计尝试数，恒有 success <= attempts |
| `as_of` | `integer` | 上报生效时点；分析只取 `as_of <= 截止值` 的记录 |
| `revision` | `integer` | 同点同期间的修订号，合法值取最大修订 |
| `reset` | `boolean` | 台账重置标记；为 true 时该期间重新起账 |

## 合法修订选择（`src/ledger.js`）

1. 剔除所有 `as_of` 晚于分析截止的记录，记录在 `ledgerAudit.droppedAsFuture`，未来追加数据不会进入既有分析。
2. 同一 `point + period` 存在多条时取 `revision` 最大者，被替代记录写入 `ledgerAudit.superseded`；同修订号冲突直接报错，不静默选边。
3. 按期间排序还原增量：正常期间增量 = 本期累计 − 上期累计；未标 `reset` 的累计回退直接报错。
4. `reset=true` 的期间重新起账，增量取其自身累计值，重置前累计保留在 `ledgerAudit.resets` 中，新旧账绝不相加。
5. 零尝试期间增量为 0/0，不会产生伪造成功；首条快照视为该点起点。

## 训练窗口与分层先验（`src/prior.js`）

- 策略中的 `trainThrough` 划定封存训练窗口（`period <= trainThrough`），其后为分析窗口。先验超参数**只**由训练期点级计数估计，分析期数据只进入后验。
- 先验在 `poolBy`（默认 region × service）层内共享，模型为 Beta-Binomial：点成功率 θ ~ Beta(α,β)，观测 y|n ~ Binomial(n, θ)。
- 超参数用矩估计：μ 为层内池化率，R 为按样本量加权的点率方差，由 Beta-Binomial 方差恒等式解集中参数 M = α+β。估计目标、原始池化率、调整后 μ、M、组内相关 1/(M+1)、过度离散因子和边界标记全部写入 `layerPriors`。
- 边界解显式标记：`meanBoundary`（全成功/全失败，加 2 平滑并保留原始率）、`singlePointConcentrationUnidentified`（层内仅一个有效点，M 不可识别，取上限）、`noDetectableOverdispersion`（M 触上限）、`maxOverdispersionBoundary`（M 触下限）。
- 层内训练期没有任何尝试时先验状态为 `unavailable`：该层各点只报告原始率与数据缺口，**不借用全局先验**，不参与跨点排序，标准化中作为缺失层列出。

## 后验、阈值概率与排序不确定性（`src/simulate.js`）

- 共轭后验 Beta(α+y, β+n−y)，逐点保留先验参数、加入计数和手算结果（`conjugateCheck`），不一致则拒绝出报告。
- 每个点同时给出分析期原始率、后验收缩均值、标准差和可信区间。
- 决策量 `probabilityBelowThreshold = P(θ < 业务阈值)` 与 `probabilityAtLeastThreshold` 由正则化不完全 Beta **精确**计算，不依赖抽样。
- 排序不确定性由确定性随机种子（splitmix64）的蒙特卡洛产生：名次分布、进入前 k 概率、成对占优概率及各自的伯努利标准误。报告按点标识排列，不提供按均值排好的排行榜；先验不可用点显式排除并列出原因。

## 固定业务结构标准化（`src/standardize.js`）

跨层比较使用与交易量无关的固定层权重混合层后验，给出标准化率的解析均值、方差和抽样可信区间；同时并列按实际尝试量加权的总体粗率。两者口径不同：标准化率回答“在固定业务结构下各层表现的合成水平”，总体粗率回答“单笔交易的平均成功率”，小层在前者中不会被大交易量淹没，二者不能互相替代。先验不可用层会使标准化降级为 `partial` 并在可用层上重新归一化权重。

## 更新日志与可重建性（`src/journal.js`）

- `journal-init` 封存训练窗口并保存基础台账指纹；之后任何训练期记录都被拒绝，先验不随后续数据改变。
- 每个批次（`journal-add`）只能接受一次：批次号重复、记录指纹重复、含训练期记录都会报错。
- `journal-withdraw` 撤回批次但保留痕迹；`journal-rebuild` 重放基础台账加全部有效批次重建后验，撤回数据不参与。历史分析工件不被覆盖，追加未来数据无法反改 `as_of` 截止下的既有结论。

## 策略配置（`data/policy.json`，版本 2）

| 字段 | 说明 |
| --- | --- |
| `trainThrough` / `asOf` | 封存训练窗口边界与合法修订截止 |
| `threshold` | 业务阈值，用于阈值后验概率 |
| `poolBy` | 共享先验的分层字段，取自 region/service |
| `layerWeights` 或 `standardWeights` | 固定结构权重：直接按层，或按 region 在 service 间等权展开；权重和必须为 1 |
| `credibleLevel` / `draws` / `seed` | 可信水平、MC 抽样规模与确定性种子 |
| `review.watchProbability` / `review.actionProbability` | 决策分组阈值（观察/调整），后者必须更大 |
| `review.concentrationCap` | 集中参数 M 的上界 |

`inspect` 返回输入行数、字段列表与 SHA-256 指纹；`summary` 保留现有按 service 的逐行清点口径（`data/expected-summary.json` 为独立对照），不代表统计推断。数据版本不支持时直接拒绝，不做静默迁移；错误发生时命令返回非零退出码。
