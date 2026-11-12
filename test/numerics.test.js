import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarize } from '../src/domain.js';

const seed = JSON.parse(await readFile('data/records.json', 'utf8')).records[0];
const probe = patches => summarize(patches.map((patch, index) => ({...seed, id: `p${index}`, ...patch}))).groups[0];

test('上报核对保留显式成功数，不以尝试次数替代', () => {

  assert.equal(probe([{success: 2, attempts: 2}, {success: 60, attempts: 100}]).reportedSuccess, 62);
  assert.equal(probe([{success: 0, attempts: 0}]).reportedSuccess, 0);
});
