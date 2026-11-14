import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult } from './output.js';
import { estimatePriors } from './prior.js';
import { analyze } from './model.js';
import { reconstructLedger } from './ledger.js';
import { renderReport } from './report.js';
import { applyBatch, createState, rebuildAnalysis, withdrawBatch } from './updates.js';
import { fingerprint } from './dataset.js';

const COMMANDS = ['summary', 'inspect', 'analyze', 'report', 'update', 'withdraw'];
const VALUE_OPTIONS = ['--input', '--out', '--policy', '--state', '--batch', '--batch-id', '--as-of', '--seed', '--draws'];
const FLAGS = [];

export function parseArguments(args) {
  const [command = 'summary', ...options] = args;
  if (!COMMANDS.includes(command)) throw new Error(`命令应为 ${COMMANDS.join('、')} 之一`);
  const result = { command, input: 'data/records.json' };
  for (let index = 0; index < options.length; index += 1) {
    const name = options[index];
    if (FLAGS.includes(name)) {
      result[name.slice(2)] = true;
      continue;
    }
    const value = options[index + 1];
    if (!VALUE_OPTIONS.includes(name) || !value || value.startsWith('--')) {
      throw new Error(`参数 ${name} 缺少合法取值`);
    }
    const key = name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (result[key] !== undefined && name !== '--input') throw new Error(`参数 ${name} 不可重复`);
    result[key] = value;
    index += 1;
  }
  return result;
}

async function loadPolicy(path = 'data/policy.json') {
  const policy = JSON.parse(await readFile(resolve(path), 'utf8'));
  const required = ['trainThrough', 'asOf', 'threshold', 'poolBy', 'standardWeights'];
  for (const field of required) {
    if (policy[field] === undefined) throw new Error(`业务配置缺少 ${field}`);
  }
  if (!Array.isArray(policy.poolBy) || policy.poolBy.length === 0) throw new Error('poolBy 必须为非空数组');
  return policy;
}

function buildAnalysis(records, policy, options = {}) {
  const asOf = options.asOf ? Number(options.asOf) : policy.asOf;
  const monteCarlo = {
    seed: options.seed ? Number(options.seed) : 20261114,
    draws: options.draws ? Number(options.draws) : 10000,
  };
  const ledger = reconstructLedger(records, asOf);
  const priors = estimatePriors(ledger.increments, {
    trainThrough: policy.trainThrough,
    poolBy: policy.poolBy,
  });
  const analysis = analyze(ledger.increments, priors, policy, monteCarlo);
  return {
    version: 1,
    asOf,
    inputFingerprint: fingerprint(records),
    ledger: {
      legalRecordCount: ledger.legal.length,
      supersededRecordIds: ledger.superseded,
      futureRecordIds: ledger.future,
      resets: ledger.resets,
      increments: ledger.increments,
    },
    priors,
    analysis,
  };
}

export async function main(args) {
  const options = parseArguments(args);
  const dataset = await loadDataset(options.input);
  let document;
  if (options.command === 'summary') {
    document = { ...summarize(dataset.records), inputFingerprint: dataset.fingerprint };
  } else if (options.command === 'inspect') {
    document = {
      records: dataset.records.length,
      fingerprint: dataset.fingerprint,
      fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [],
    };
  } else if (options.command === 'analyze') {
    const policy = await loadPolicy(options.policy);
    document = buildAnalysis(dataset.records, policy, options);
  } else if (options.command === 'report') {
    const policy = await loadPolicy(options.policy);
    const result = buildAnalysis(dataset.records, policy, options);
    const markdown = renderReport(result);
    document = { ...result, report: markdown };
  } else if (options.command === 'update') {
    if (!options.batch || !options.batchId) throw new Error('update 需要 --batch 路径 与 --batch-id 标识');
    if (!options.state) throw new Error('update 需要 --state 状态文件路径');
    const policy = await loadPolicy(options.policy);
    let state;
    try {
      state = JSON.parse(await readFile(resolve(options.state), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      state = createState(policy);
    }
    const batchDataset = await loadDataset(options.batch);
    const { state: nextState, inputFingerprint } = applyBatch(state, {
      batchId: options.batchId,
      appliedAt: policy.asOf,
      records: batchDataset.records,
    });
    // 训练窗口、先验配置与更新批次随状态一起持久化，保证后续批次与撤回可复算。
    await writeResult(options.state, nextState);
    const rebuilt = rebuildAnalysis(nextState);
    document = { state: nextState, inputFingerprint, ...rebuilt };
  } else {
    if (!options.state) throw new Error('withdraw 需要 --state 状态文件路径');
    if (!options.batchId) throw new Error('withdraw 需要 --batch-id 标识');
    const state = JSON.parse(await readFile(resolve(options.state), 'utf8'));
    const { state: nextState } = withdrawBatch(state, options.batchId);
    await writeResult(options.state, nextState);
    document = { state: nextState, ...rebuildAnalysis(nextState) };
  }
  if (options.out) await writeResult(options.out, document);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
