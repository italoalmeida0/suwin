import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditLog } from '../src/log.js';

test('audit log writes JSON records and retains bounded rotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suwin-log-test-'));
  try {
    const log = createAuditLog(dir, { maxBytes: 500 });
    for (let i = 0; i < 20; i++) log.info('session_exited', { session: String(i), code: 0 });
    const file = path.join(dir, 'suwinsvc.log');
    assert.ok(fs.statSync(file).size <= 500);
    assert.ok(fs.statSync(file + '.1').size <= 500);
    const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.at(-1).session, '19');
    assert.equal(records.at(-1).event, 'session_exited');
    assert.ok(records.every(record => record.time && record.level === 'info'));
  } finally {
    const target = fs.realpathSync(dir);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('suwin-log-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
});
