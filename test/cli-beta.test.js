import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArguments } from '../src/cli.js';
const run = args => spawnSync(process.execPath, ['src/cli.js', ...args], { encoding: 'utf8' });
let folder;

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'bb-cli-'));
});
test.afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

test('analyze 命令产出后验、阈值概率与排序不确定性并可落盘', async () => {
  const out = join(folder, 'analysis.json');
  const result = run(['analyze', '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.ok(Array.isArray(saved.analysis.points));
  assert.ok(saved.analysis.points.length > 10);
  const estimated = saved.analysis.points.filter(point => point.status === 'estimated');
  for (const point of estimated) {
    assert.ok('probabilityBelowThreshold' in point.posterior);
    assert.ok('rankInterval95' in point.ranking);
  }
  assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), saved);
});

test('report 命令返回带不确定性说明的 Markdown 清单', () => {
  const result = run(['report']);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(result.stdout);
  assert.match(saved.report, /资源复核清单/);
  assert.match(saved.report, /P\(率<阈值\)/);
  assert.match(saved.report, /夺冠概率/);
});

test('批次更新落盘后可撤回并重建，一批只接受一次', async () => {
  const state = join(folder, 'state.json');
  const batch = join(folder, 'batch.json');
  const seedRecord = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
  const extra = [{ ...seedRecord, id: 'b-r1', point: 'pNew', period: 7, success: 2, attempts: 2, as_of: 8 }];
  await writeFile(batch, JSON.stringify({ version: 1, records: extra }));
  const first = run(['update', '--state', state, '--batch', batch, '--batch-id', 'batch-1', '--out', join(folder, 'u1.json')]);
  assert.equal(first.status, 0, first.stderr);
  const again = run(['update', '--state', state, '--batch', batch, '--batch-id', 'batch-1']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /只能更新一次/);
  const withdrawn = run(['withdraw', '--state', state, '--batch-id', 'batch-1', '--out', join(folder, 'u2.json')]);
  assert.equal(withdrawn.status, 0, withdrawn.stderr);
  const rebuilt = JSON.parse(withdrawn.stdout);
  assert.equal(rebuilt.updateLog.length, 0);
  assert.ok(!rebuilt.analysis.points.some(point => point.point === 'pNew'));
});

test('--as-of 隔离未来修订，切换时点结果可区分', () => {
  const atTen = run(['analyze', '--as-of', '10']);
  const atEleven = run(['analyze', '--as-of', '11']);
  assert.equal(atTen.status, 0, atTen.stderr);
  const ten = JSON.parse(atTen.stdout);
  const eleven = JSON.parse(atEleven.stdout);
  assert.deepEqual(ten.ledger.futureRecordIds.length > 0, true);
  assert.equal(eleven.ledger.futureRecordIds.length, 0);
  const p0Ten = ten.analysis.points.find(point => point.point === 'p0');
  const p0Eleven = eleven.analysis.points.find(point => point.point === 'p0');
  assert.notDeepEqual([p0Ten.success, p0Ten.attempts], [p0Eleven.success, p0Eleven.attempts]);
});

test('非法命令与悬空参数被拒绝', () => {
  assert.throws(() => parseArguments(['frobnicate']), /命令/);
  assert.throws(() => parseArguments(['analyze', '--out']), /缺少合法取值/);
  assert.throws(() => parseArguments(['analyze', '--bogus', 'x']), /缺少合法取值/);
  assert.equal(parseArguments(['analyze', '--draws', '100']).draws, '100');
});

test('显式 --input 覆盖默认路径而不报重复', () => {
  const parsed = parseArguments(['analyze', '--input', 'var/e2e/no-future.json']);
  assert.equal(parsed.input, 'var/e2e/no-future.json');
  assert.throws(() => parseArguments(['analyze', '--out', 'a.json', '--out', 'b.json']), /不可重复/);
});

test('report 可写到文件且包含标准化与总体率口径解释', async () => {
  const out = join(folder, 'report.json');
  const result = run(['report', '--out', out]);
  assert.equal(result.status, 0, result.stderr);
  const saved = JSON.parse(await readFile(out, 'utf8'));
  assert.match(saved.report, /全体交易总体率/);
  assert.match(saved.report, /不是同一估计目标|不.*同一/);
});

