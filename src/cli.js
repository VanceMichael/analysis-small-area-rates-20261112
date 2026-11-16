import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadDataset } from './dataset.js';
import { summarize } from './domain.js';
import { writeResult, writeText } from './output.js';
import { loadPolicy } from './policy.js';
import { runReview } from './review.js';
import { renderReviewMarkdown } from './report.js';
import {
  initializeJournal, addBatch, withdrawBatch,
  saveJournal, loadJournal, activeRecords
} from './journal.js';

const COMMANDS = ['summary', 'inspect', 'review', 'journal-init', 'journal-add', 'journal-withdraw', 'journal-rebuild'];
const FLAGS = new Set(['--input', '--out', '--policy', '--journal', '--batch-id', '--markdown']);

export function parseArguments(args) {
  const [command = 'summary', ...tokens] = args;
  if (!COMMANDS.includes(command)) throw new Error(`命令应为 ${COMMANDS.join('、')} 之一`);
  const defaults = { input: 'data/records.json', policy: 'data/policy.json' };
  const seen = new Set();
  const result = { command, ...defaults };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!FLAGS.has(token)) throw new Error(`不支持的参数：${token}`);
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`参数 ${token} 缺少取值`);
    const name = token.slice(2);
    if (name === 'markdown') {
      if (seen.has('markdown')) throw new Error('参数 --markdown 不可重复');
      result.markdown = value;
    } else {
      if (seen.has(name)) throw new Error(`参数 ${token} 不可重复`);
      result[name] = value;
    }
    seen.add(name);
    index += 1;
  }
  return result;
}

async function readPolicy(path) {
  return loadPolicy(JSON.parse(await readFile(resolve(path), 'utf8')));
}

export async function main(args) {
  const options = parseArguments(args);
  if (options.command === 'summary' || options.command === 'inspect') {
    const dataset = await loadDataset(options.input);
    const result = options.command === 'summary' ? summarize(dataset.records)
      : { records: dataset.records.length, fingerprint: dataset.fingerprint,
        fields: dataset.records.length ? Object.keys(dataset.records[0]).sort() : [] };
    const document = { ...result, inputFingerprint: dataset.fingerprint };
    if (options.out) await writeResult(options.out, document);
    return document;
  }
  if (options.command === 'review') {
    const dataset = await loadDataset(options.input);
    const policy = await readPolicy(options.policy);
    const report = runReview(dataset.records, policy);
    if (options.out) await writeResult(options.out, report);
    if (options.markdown) await writeText(options.markdown, renderReviewMarkdown(report, policy));
    return report;
  }
  if (!options.journal) throw new Error('日志命令需要 --journal 路径');
  const journalPath = resolve(options.journal);
  if (options.command === 'journal-init') {
    const dataset = await loadDataset(options.input);
    const policy = await readPolicy(options.policy);
    const journal = initializeJournal({
      inputRecords: dataset.records, policy, inputFingerprint: dataset.fingerprint
    });
    await saveJournal(journalPath, journal);
    return { command: 'journal-init', journal: journalPath, baseFingerprint: journal.baseFingerprint,
      snapshotFingerprint: journal.snapshotFingerprint, batches: 0 };
  }
  if (options.command === 'journal-add') {
    if (!options['batch-id']) throw new Error('journal-add 需要 --batch-id');
    const journal = await loadJournal(journalPath);
    const dataset = await loadDataset(options.input);
    addBatch(journal, options['batch-id'], dataset.records);
    await saveJournal(journalPath, journal);
    return { command: 'journal-add', batchId: options['batch-id'], activeBatches: journal.batches.length };
  }
  if (options.command === 'journal-withdraw') {
    if (!options['batch-id']) throw new Error('journal-withdraw 需要 --batch-id');
    const journal = await loadJournal(journalPath);
    withdrawBatch(journal, options['batch-id']);
    await saveJournal(journalPath, journal);
    return { command: 'journal-withdraw', batchId: options['batch-id'],
      activeBatches: journal.batches.length, withdrawnBatches: journal.withdrawnBatches.length };
  }
  // journal-rebuild：重放有效批次并重新出复核结果，撤回批次不参与
  const journal = await loadJournal(journalPath);
  const policy = await readPolicy(options.policy);
  const records = activeRecords(journal);
  const report = runReview(records, policy);
  if (options.out) await writeResult(options.out, report);
  if (options.markdown) {
    await writeText(options.markdown, renderReviewMarkdown(report, policy));
  }
  return {
    command: 'journal-rebuild',
    journal: journalPath,
    activeBatches: journal.batches.map(batch => batch.batchId),
    withdrawnBatches: journal.withdrawnBatches.map(batch => batch.batchId),
    recordCount: records.length,
    reviewOut: options.out ? resolve(options.out) : null,
    markdownOut: options.markdown ? resolve(options.markdown) : null,
    report
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }).catch(error => {
    process.stderr.write(`处理失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
