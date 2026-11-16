import { open, mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical } from './dataset.js';

async function writeAtomic(path, contents) {
  const destination = resolve(path);
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } finally {
    if (handle) await handle.close();
    await rm(temporary, { force: true });
  }
}

export async function writeResult(path, value) {
  await writeAtomic(path, JSON.stringify(canonical(value), null, 2) + '\n');
}

export async function writeText(path, text) {
  if (typeof text !== 'string') throw new Error('writeText 只接受字符串');
  await writeAtomic(path, text.endsWith('\n') ? text : `${text}\n`);
}
