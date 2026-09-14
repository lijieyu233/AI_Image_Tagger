// db.js 单元/集成测试：upsertTag 冲突复位 rejected、ensureTag 幂等、rejectCounts、默认阈值常量。
// 隔离数据目录，不触碰真实库；不加载 CLIP，不联网。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagger-db-'));
process.env.TAGGER_DATA_DIR = path.join(tmp, 'data');
process.env.TAGGER_THUMBS_DIR = path.join(tmp, 'thumbs');
process.env.TAGGER_INBOX_DIR = path.join(tmp, 'inbox');
process.env.TAGGER_DB_PATH = path.join(tmp, 'data', 'library.db');
process.env.TAGGER_TAGS_FILE = path.join(ROOT, 'config', 'tags.json');

let db, getDb, ensureTag, upsertTag, rejectTag, rejectCounts, DEFAULT_THRESHOLD;

before(async () => {
  ({ getDb, ensureTag, upsertTag, rejectTag, rejectCounts } = await import('../src/db.js'));
  ({ DEFAULT_THRESHOLD } = await import('../src/config.js'));
  db = getDb();
  db.prepare("INSERT INTO photos (path, file_hash, imported_at, status) VALUES ('p.jpg', 'h', ?, 'ready')").run(new Date().toISOString());
});

after(async () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 安全删除 shim 可能拦截，忽略 */ }
});

test('DEFAULT_THRESHOLD 是合理数值（0.15~0.35）', () => {
  assert.equal(typeof DEFAULT_THRESHOLD, 'number');
  assert.ok(DEFAULT_THRESHOLD > 0.15 && DEFAULT_THRESHOLD < 0.35);
});

test('ensureTag 幂等：同名同组返回同一 id', () => {
  const a = ensureTag('幂等标签X', '用途', 'manual');
  const b = ensureTag('幂等标签X', '用途', 'manual');
  assert.equal(a, b);
});

test('upsertTag 冲突时复位 rejected（手动重新添加曾被驳回的标签应可见）', () => {
  const id = 1;
  const tagId = ensureTag('曾被驳回Y', '物品', 'auto');
  upsertTag(id, tagId, 'clip', 0.2);
  rejectTag(id, tagId, 'remove'); // 用户驳回 → rejected=1
  let row = db.prepare('SELECT rejected, source FROM photo_tags WHERE photo_id=? AND tag_id=?').get(id, tagId);
  assert.equal(row.rejected, 1, '驳回后应为 1');
  // 用户手动重新添加该标签（如灯箱「＋ 加标签」）
  upsertTag(id, tagId, 'manual', 1.0);
  row = db.prepare('SELECT rejected, source FROM photo_tags WHERE photo_id=? AND tag_id=?').get(id, tagId);
  assert.equal(row.rejected, 0, 'rejected 应被复位为 0，否则手动添加的标签会被界面过滤隐藏');
  assert.equal(row.source, 'manual');
});

test('rejectCounts 统计每个标签的移除反馈次数', () => {
  const id = 1;
  const tagId = ensureTag('反馈标签Z', '物品', 'auto');
  rejectTag(id, tagId, 'remove');
  const counts = rejectCounts();
  assert.equal(counts['反馈标签Z'], 1);
});
