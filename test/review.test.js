import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runReview } from '../src/review.js';
import { renderReviewMarkdown } from '../src/report.js';
import { loadPolicy } from '../src/policy.js';
import { reconstructLedger } from '../src/ledger.js';

const casePolicy = loadPolicy(JSON.parse(await readFile('data/case-policy.json', 'utf8')));
const mainPolicy = loadPolicy(JSON.parse(await readFile('data/policy.json', 'utf8')));
const cases = JSON.parse(await readFile('data/case-records.json', 'utf8')).records;
const mainRecords = JSON.parse(await readFile('data/records.json', 'utf8')).records;

test('复核结果确定性：同输入同种子产生相同指纹', () => {
  const first = runReview(cases, casePolicy);
  const second = runReview([...cases].reverse(), casePolicy);
  assert.equal(first.canonicalFingerprint, second.canonicalFingerprint);
  assert.equal(first.checks.conjugate.allPass, true);
});

test('共轭手算核对逐点保留明细且全部通过', () => {
  const report = runReview(cases, casePolicy);
  for (const point of report.points) {
    if (point.conjugateCheck.status === 'skipped') {
      assert.equal(point.priorStatus, 'unavailable');
      continue;
    }
    assert.equal(point.conjugateCheck.status, 'pass');
    assert.equal(point.conjugateCheck.handAlpha, point.conjugateCheck.posteriorAlpha);
    assert.equal(point.conjugateCheck.handBeta, point.conjugateCheck.posteriorBeta);
  }
});

test('追加未来数据不会反改 as_of 截止下的既有分析', () => {
  const before = runReview(cases, casePolicy);
  const futureRows = [
    { id: 'future-1', point: 'A', region: 'north', service: 'card', period: 9, success: 99, attempts: 100, as_of: 13, revision: 1, reset: false },
    { id: 'future-2', point: 'A', region: 'north', service: 'card', period: 8, success: 30, attempts: 40, as_of: 12, revision: 3, reset: false }
  ];
  const after = runReview([...cases, ...futureRows], casePolicy);
  assert.deepEqual(after.ledgerAudit.droppedAsFuture.sort(), ['e0009', 'future-1', 'future-2']);
  // 推断结论不变：先验、点后验、排序与标准化分析内容逐字段一致
  assert.deepEqual(after.layerPriors, before.layerPriors);
  assert.deepEqual(after.points, before.points);
  assert.deepEqual(after.ranking, before.ranking);
  assert.deepEqual(after.standardization, before.standardization);
  assert.deepEqual(after.checks, before.checks);
  // 输入指纹与审计计数如实反映新增行（但不影响任何分析数值）
  assert.notEqual(after.run.inputFingerprint, before.run.inputFingerprint);
  assert.equal(after.ledgerAudit.inputRecords, before.ledgerAudit.inputRecords + 2);
});

test('提高 as_of 截止使修订生效时结果确实改变且审计可追溯', () => {
  const before = runReview(cases, casePolicy);
  const laterPolicy = { ...casePolicy, asOf: 11 };
  const after = runReview(cases, laterPolicy);
  assert.notEqual(after.canonicalFingerprint, before.canonicalFingerprint);
  assert.deepEqual(after.ledgerAudit.droppedAsFuture, []);
  assert.ok(after.ledgerAudit.superseded.some(item => item.keptId === 'e0009'));
});

test('新点借本层信息收缩，但两笔成功不会成为冠军', () => {
  const report = runReview(cases, casePolicy);
  const fresh = report.points.find(item => item.point === 'N');
  assert.equal(fresh.rawRate, 1);
  assert.ok(fresh.posterior.mean < 0.6, `新点收缩后均值 ${fresh.posterior.mean} 应明显低于原始率 1`);
  const rank = report.ranking.rankings.find(item => item.point === 'N');
  assert.ok(rank.topK[0].probability < 0.05);
});

test('无训练层的点只给原始率与缺口标记，不参与排序和标准化', () => {
  const report = runReview(cases, casePolicy);
  const gap = report.points.find(item => item.point === 'D');
  assert.equal(gap.priorStatus, 'unavailable');
  assert.equal(gap.rawRate, 1);
  assert.equal(gap.probabilityBelowThreshold, null);
  assert.equal(gap.decision, 'data-gap');
  assert.ok(report.ranking.unavailable.some(item => item.point === 'D'));
  assert.ok(report.standardization.missingLayers.some(item => item.layerKey === 'south/language'));
});

test('决策分组与阈值后验概率一致，且输出不按均值排序', () => {
  const report = runReview(cases, casePolicy);
  const pointIds = report.points.map(item => item.point);
  assert.deepEqual(pointIds, [...pointIds].sort((a, b) => a.localeCompare(b, 'en')));
  for (const item of report.points) {
    if (item.decision === 'adjust-resource') assert.ok(item.probabilityBelowThreshold >= 0.8);
    if (item.decision === 'hold' && item.probabilityBelowThreshold != null) {
      assert.ok(item.probabilityBelowThreshold < 0.5);
    }
  }
});

test('主数据复核：原始率、收缩估计、可信区间同时呈现', () => {
  const report = runReview(mainRecords, mainPolicy);
  assert.equal(report.points.length, 12);
  for (const item of report.points) {
    assert.ok(item.rawRate >= 0 && item.rawRate <= 1);
    assert.ok(item.posterior.credible.lower <= item.posterior.mean);
    assert.ok(item.posterior.mean <= item.posterior.credible.upper);
  }
  // 标准化率与粗率都存在且口径不同
  const { standardization: std } = report;
  assert.ok(Math.abs(std.standardizedRate.mean - std.crudePooledRate) > 1e-4);
  assert.ok(std.note.includes('固定'));
});

test('Markdown 清单包含决策、排序不确定性与标准化口径说明', () => {
  const report = runReview(cases, casePolicy);
  const markdown = renderReviewMarkdown(report, casePolicy);
  for (const heading of ['资源复核清单', '台账合规审计', '排序不确定性', '固定业务结构标准化', '方法学与复核说明']) {
    assert.ok(markdown.includes(heading), `缺少章节 ${heading}`);
  }
  assert.ok(markdown.includes('reset=true'));
  assert.ok(markdown.includes('data-gap'));
  assert.ok(!markdown.includes('"# '));
});

test('CLI review/journal 全流程：初始化、加批、撤回、重建落盘', () => {
  const folder = join(tmpdir(), `review-cli-${process.pid}`);
  try {
    const journal = join(folder, 'journal.json');
    const reviewOut = join(folder, 'review.json');
    const markdownOut = join(folder, 'review.md');
    const batchFile = join(folder, 'batch.json');
    const batchRecords = [{
      id: 'batch-1', point: 'E', region: 'north', service: 'language',
      period: 9, success: 3, attempts: 5, as_of: 12, revision: 1, reset: false
    }];
    const run = args => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
    let result = run(['journal-init', '--input', 'data/case-records.json', '--policy', 'data/case-policy.json', '--journal', journal]);
    assert.equal(result.status, 0, result.stderr);
    const batch = { version: 1, records: batchRecords };
    writeFileSync(batchFile, JSON.stringify(batch));
    result = run(['journal-add', '--input', batchFile, '--journal', journal, '--batch-id', 'b-2026-01']);
    assert.equal(result.status, 0, result.stderr);
    // 重复批次被拒
    result = run(['journal-add', '--input', batchFile, '--journal', journal, '--batch-id', 'b-2026-01']);
    assert.equal(result.status, 1);
    result = run(['journal-rebuild', '--policy', 'data/case-policy.json', '--journal', journal,
      '--out', reviewOut, '--markdown', markdownOut]);
    assert.equal(result.status, 0, result.stderr);
    const rebuilt = JSON.parse(result.stdout);
    assert.deepEqual(rebuilt.activeBatches, ['b-2026-01']);
    const onDisk = JSON.parse(readFileSync(reviewOut, 'utf8'));
    assert.equal(onDisk.run.inputFingerprint, rebuilt.report.run.inputFingerprint);
    assert.ok(readFileSync(markdownOut, 'utf8').startsWith('# 外卡服务点资源复核清单'));
    // 撤回后重建恢复到基础台账指纹
    result = run(['journal-withdraw', '--journal', journal, '--batch-id', 'b-2026-01']);
    assert.equal(result.status, 0, result.stderr);
    result = run(['journal-rebuild', '--policy', 'data/case-policy.json', '--journal', journal, '--out', reviewOut]);
    assert.equal(result.status, 0, result.stderr);
    const withdrawn = JSON.parse(result.stdout);
    assert.deepEqual(withdrawn.activeBatches, []);
    assert.deepEqual(withdrawn.withdrawnBatches, ['b-2026-01']);
    const baseline = runReview(cases, casePolicy);
    assert.equal(JSON.parse(readFileSync(reviewOut, 'utf8')).canonicalFingerprint,
      baseline.canonicalFingerprint);
  } finally {
    rm(folder, { recursive: true, force: true });
  }
});

test('CLI 保留原有 summary/inspect 行为与错误退出码', () => {
  const run = args => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
  assert.equal(run(['unknown']).status, 1);
  assert.equal(run(['review', '--policy']).status, 1);
  const inspect = run(['inspect', '--input', 'data/records.json']);
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).records, 96);
});

test('重建台账在合成用例上的审计数字与手工核对一致', () => {
  const ledger = reconstructLedger(cases, 10);
  assert.equal(ledger.audit.inputRecords, 44);
  assert.equal(ledger.audit.droppedAsFuture.length, 1);
  assert.equal(ledger.audit.superseded.length, 1);
  assert.equal(ledger.audit.resetCount, 1);
});

test('零尝试分析期后验等于先验，全成功点仍给出精确阈值概率', () => {
  const report = runReview(cases, casePolicy);
  const c = report.points.find(item => item.point === 'C');
  // C 的期间 7 为 0/0，分析期合计仅期间 8 的 4/8
  assert.equal(c.analysisWindow.attempts, 8);
  const prior = report.layerPriors.find(item => item.layerKey === 'south/card');
  assert.ok(Math.abs(c.posterior.alpha - (prior.alpha + 4)) < 1e-9);
  assert.ok(Math.abs(c.posterior.beta - (prior.beta + 4)) < 1e-9);
  const b = report.points.find(item => item.point === 'B');
  assert.ok(b.probabilityBelowThreshold > 0 && b.probabilityBelowThreshold < 1);
});

test('CLI review 不传 markdown 时不写文本，传了才落盘', () => {
  const folder = join(tmpdir(), `review-md-${process.pid}`);
  try {
    const jsonOut = join(folder, 'r.json');
    const mdOut = join(folder, 'r.md');
    const run = args => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
    const onlyJson = run(['review', '--input', 'data/case-records.json', '--policy', 'data/case-policy.json', '--out', jsonOut]);
    assert.equal(onlyJson.status, 0, onlyJson.stderr);
    assert.ok(!existsSync(mdOut));
    const withMd = run(['review', '--input', 'data/case-records.json', '--policy', 'data/case-policy.json',
      '--out', jsonOut, '--markdown', mdOut]);
    assert.equal(withMd.status, 0, withMd.stderr);
    assert.ok(readFileSync(mdOut, 'utf8').startsWith('# '));
  } finally {
    rm(folder, { recursive: true, force: true });
  }
});
