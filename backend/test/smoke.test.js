// 后端冒烟测试：在隔离数据目录启动服务，验证导入/筛选/统计/标签/重导入/导出。
// 不加载 CLIP（不触发模型下载），因此可在任意环境快速跑通，作为后续迭代的回归保护网。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// 必须在 import 业务模块前设好环境变量（config.js 在加载时读取）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagger-test-'));
process.env.TAGGER_DATA_DIR = path.join(tmp, 'data');
process.env.TAGGER_THUMBS_DIR = path.join(tmp, 'thumbs');
process.env.TAGGER_INBOX_DIR = path.join(tmp, 'inbox');
process.env.TAGGER_DB_PATH = path.join(tmp, 'data', 'library.db');
process.env.TAGGER_TAGS_FILE = path.join(ROOT, 'config', 'tags.json');
process.env.TAGGER_WEB_DIST = path.join(ROOT, 'web', 'dist');
const TEST_PORT = 0; // 0 = 让系统分配空闲端口，避免和真实服务冲突
process.env.PORT = String(TEST_PORT);
let BASE = `http://127.0.0.1:${TEST_PORT}`;

let server;
let sharp;

async function makeImage(filePath, w, h, color) {
  await sharp({ create: { width: w, height: h, channels: 3, background: color } })
    .png()
    .toFile(filePath);
}

async function json(method, p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

// 构造 multipart/form-data 请求体并上传（用于 /v1/import-files）
async function uploadFiles(parts) {
  const boundary = '----taggertest' + Date.now();
  const chunks = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType}\r\n\r\n`));
    chunks.push(p.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(chunks);
  const res = await fetch(`${BASE}/v1/import-files`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

before(async () => {
  sharp = (await import('sharp')).default;
  const importDir = path.join(tmp, 'import');
  fs.mkdirSync(path.join(importDir, 'sub'), { recursive: true });
  await makeImage(path.join(importDir, 'photo1.jpg'), 120, 120, '#ff5555');
  await makeImage(path.join(importDir, 'Screenshot_2024.png'), 200, 120, '#55ff55');
  await makeImage(path.join(importDir, 'wide.png'), 1000, 100, '#5555ff');
  await makeImage(path.join(importDir, 'sub', 'inside.jpg'), 80, 80, '#ffff55');

  const { startServer } = await import('../src/server.js');
  server = startServer();
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  BASE = `http://127.0.0.1:${server.address().port}`;
  await new Promise((r) => setTimeout(r, 100));
});

after(async () => {
  if (server) server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 安全删除 shim 可能拦截，忽略 */ }
});

test('导入：扫描目录入库并打出规则/来源标签', async () => {
  const r = await json('POST', '/v1/import', { dir: path.join(tmp, 'import') });
  assert.equal(r.status, 200);
  assert.equal(r.data.stats.total, 4);
  assert.equal(r.data.stats.new, 4);
  assert.equal(r.data.stats.dup, 0);
});

test('统计：总数与未分类正确', async () => {
  const r = await json('GET', '/v1/stats');
  assert.equal(r.data.total, 4);
  assert.equal(r.data.unclassified, 4); // 还没跑 CLIP
});

test('标签计数：规则标与来源目录标生效', async () => {
  const r = await json('GET', '/v1/tags');
  assert.equal(r.data.countMap['截图'], 1);   // 文件名含 Screenshot
  assert.equal(r.data.countMap['全景'], 1);   // wide.png 宽高比 > 2.5
  assert.equal(r.data.countMap['sub'], 1);    // 来源目录 sub/
});

test('词表：新增与删除标签', async () => {
  const add = await json('POST', '/v1/tags', { name: '测试标签X', group: '用途', kind: 'manual' });
  assert.equal(add.status, 200);
  assert.equal(add.data.ok, true);
  const del = await json('DELETE', '/v1/tags/' + encodeURIComponent('测试标签X'));
  assert.equal(del.status, 200);
  assert.equal(del.data.ok, true);
  const again = await json('DELETE', '/v1/tags/' + encodeURIComponent('测试标签X'));
  assert.equal(again.status, 404);
});

test('筛选：按标签名过滤', async () => {
  const r = await json('GET', '/v1/photos?tags=' + encodeURIComponent('截图') + '&op=and');
  assert.equal(r.data.total, 1);
  assert.equal(r.data.items[0].tags.some((t) => t.name === '截图'), true);
});

test('智能相册：未分类 = 4', async () => {
  const r = await json('GET', '/v1/photos?smart=unclassified');
  assert.equal(r.data.total, 4);
});

test('搜索：按标签名关键字过滤', async () => {
  const r = await json('GET', '/v1/photos?q=' + encodeURIComponent('截图'));
  assert.equal(r.data.total, 1);
  assert.equal(r.data.items[0].tags.some((t) => t.name === '截图'), true);
});

test('重导入：内容不变 → 全部 skip，不新增', async () => {
  const r = await json('POST', '/v1/import', { dir: path.join(tmp, 'import') });
  assert.equal(r.data.stats.skip, 4);
  assert.equal(r.data.stats.new, 0);
  const s = await json('GET', '/v1/stats');
  assert.equal(s.data.total, 4); // 行数不变
});

test('重导入：内容变化 → 原地更新，不重复入库', async () => {
  // 改一张图的内容（尺寸+颜色都变），路径不变
  await makeImage(path.join(tmp, 'import', 'photo1.jpg'), 300, 300, '#00ffcc');
  const r = await json('POST', '/v1/import', { dir: path.join(tmp, 'import') });
  assert.equal(r.data.stats.updated, 1);
  assert.equal(r.data.stats.new, 0);
  const s = await json('GET', '/v1/stats');
  assert.equal(s.data.total, 4); // 仍只有 4 行，无 UNIQUE 冲突
});

test('设置：阈值可读写', async () => {
  const before = await json('GET', '/v1/settings');
  assert.ok(typeof before.data.threshold === 'number');
  const r = await json('PUT', '/v1/settings', { threshold: 0.3 });
  assert.equal(r.data.threshold, 0.3);
  const after = await json('GET', '/v1/settings');
  assert.equal(after.data.threshold, 0.3);
  // 还原，避免影响其它测试/真实文件
  await json('PUT', '/v1/settings', { threshold: before.data.threshold });
});

test('分类：/v1/tag 立即返回 jobId（异步）', async () => {
  const r = await json('POST', '/v1/tag', { limit: 200 });
  assert.equal(r.status, 200);
  assert.ok(typeof r.data.jobId === 'number', '应返回 jobId 数字');
  assert.ok(['queued', 'running', 'done', 'done_with_errors', 'error'].includes(r.data.status), 'status 合法');
});

test('任务：/v1/jobs/:id 返回进度结构', async () => {
  const t = await json('POST', '/v1/tag', { limit: 200 });
  const id = t.data.jobId;
  const r = await json('GET', `/v1/jobs/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.id, id);
  assert.equal(r.data.type, 'tag');
  assert.ok('status' in r.data && 'total' in r.data && 'done' in r.data && 'error' in r.data);
  assert.ok(typeof r.data.total === 'number' && typeof r.data.done === 'number');
});

test('导出：把当前筛选复制到目标目录', async () => {
  const target = path.join(tmp, 'export-out');
  const r = await json('POST', '/v1/export', { smart: 'unclassified', target });
  assert.equal(r.status, 200);
  assert.equal(r.data.copied, 4);
  assert.equal(r.data.total, 4);
  const copied = fs.readdirSync(target).filter((f) => !f.startsWith('.'));
  assert.equal(copied.length, 4);
});

test('导入：文件上传（multipart）入库', async () => {
  const buf = await sharp({ create: { width: 60, height: 60, channels: 3, background: '#aa33bb' } })
    .png().toBuffer();
  const r = await uploadFiles([{ name: 'file', filename: 'uploaded.png', contentType: 'image/png', data: buf }]);
  assert.equal(r.status, 200);
  assert.equal(r.data.stats.new, 1);
  const s = await json('GET', '/v1/stats');
  assert.equal(s.data.total, 5); // 之前 4 张 + 上传 1 张
});

test('导入：一次上传多文件（multipart 多 part）', async () => {
  const b1 = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#123456' } }).png().toBuffer();
  const b2 = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#654321' } }).png().toBuffer();
  const r = await uploadFiles([
    { name: 'file', filename: 'm1.png', contentType: 'image/png', data: b1 },
    { name: 'file', filename: 'm2.png', contentType: 'image/png', data: b2 },
  ]);
  assert.equal(r.status, 200);
  assert.equal(r.data.stats.new, 2);
});

test('导入：非 multipart 请求被拒绝（400）', async () => {
  const r = await json('POST', '/v1/import-files', { foo: 'bar' });
  assert.equal(r.status, 400);
});

test('删除：从库移除索引（不动原图）', async () => {
  const before = await json('GET', '/v1/stats');
  const photos = await json('GET', '/v1/photos?limit=1');
  const id = photos.data.items[0].id;
  const r = await json('DELETE', `/v1/photos/${id}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
  const after = await json('GET', '/v1/stats');
  assert.equal(after.data.total, before.data.total - 1);
});

test('导出：按指定 ids 复制', async () => {
  const photos = await json('GET', '/v1/photos?limit=2');
  const ids = photos.data.items.map((p) => p.id);
  const target = path.join(tmp, 'export-ids');
  const r = await json('POST', '/v1/export', { ids, target });
  assert.equal(r.status, 200);
  assert.equal(r.data.total, ids.length);
  assert.equal(r.data.copied, ids.length);
});

test('人工确认：keep 升级 manual（保留置信度）+ remove 驳回，退出待确认', async () => {
  const { getDb, upsertTag, ensureTag } = await import('../src/db.js');
  const db = getDb();
  const photos = await json('GET', '/v1/photos?limit=1');
  const id = photos.data.items[0].id;
  // 造两个低置信 clip 标签 → 应进待确认
  for (const name of ['猫', '商品']) {
    const tagId = ensureTag(name, '物品', 'auto');
    upsertTag(id, tagId, 'clip', 0.2);
  }
  const inReview = await json('GET', '/v1/photos?smart=review&limit=500');
  assert.ok(inReview.data.items.some((x) => x.id === id), '低置信应进待确认');

  const r = await json('POST', `/v1/photos/${id}/confirm`, { keep: ['猫'], remove: ['商品'] });
  assert.equal(r.data.ok, true);
  const detail = await json('GET', `/v1/photos/${id}`);
  const cat = detail.data.tags.find((t) => t.name === '猫');
  const goods = detail.data.tags.find((t) => t.name === '商品');
  assert.equal(cat.source, 'manual', '确认后升级为 manual');
  assert.equal(cat.confidence, 0.2, '保留原模型置信度');
  assert.equal(goods.rejected, 1, '移除 = 驳回（记反馈抬阈值）');
  const after = await json('GET', '/v1/photos?smart=review&limit=500');
  assert.ok(!after.data.items.some((x) => x.id === id), '有人工标签后退出待确认');
});

test('词表组开关：disabled 写入并可还原', async () => {
  const on = await json('PUT', '/v1/vocab-group', { name: '活动', disabled: true });
  assert.equal(on.data.disabled, true);
  const tags = await json('GET', '/v1/tags');
  const g = tags.data.vocab.find((x) => x.name === '活动');
  assert.equal(g.disabled, true);
  // 还原真实 config/tags.json，避免污染
  await json('PUT', '/v1/vocab-group', { name: '活动', disabled: false });
  const tags2 = await json('GET', '/v1/tags');
  assert.equal(tags2.data.vocab.find((x) => x.name === '活动').disabled, false);
});

test('AI 设置：Key 只写本地文件、返回掩码、空串不覆盖', async () => {
  const put = await json('PUT', '/v1/ai-settings', { provider: 'openai', apiKey: 'sk-test1234abcd', model: 'gpt-4o-mini' });
  assert.equal(put.data.hasKey, true);
  const get = await json('GET', '/v1/ai-settings');
  assert.equal(get.data.provider, 'openai');
  assert.equal(get.data.hasKey, true);
  assert.ok(get.data.keyMasked.startsWith('sk-t'), 'Key 掩码显示');
  assert.ok(!JSON.stringify(get.data).includes('sk-test1234abcd'), '响应永不包含明文 Key');
  // 空 apiKey 不覆盖旧值
  await json('PUT', '/v1/ai-settings', { enabled: true, apiKey: '' });
  const get2 = await json('GET', '/v1/ai-settings');
  assert.equal(get2.data.enabled, true);
  assert.equal(get2.data.hasKey, true);
});

test('AI 批量打标：未配置 Key 时返回 400 与明确提示', async () => {
  // 上面用例把 enabled 置 true 了，但 apiKey 是假的 → 走真实网络必失败；改为先关掉再验证 400 路径
  await json('PUT', '/v1/ai-settings', { enabled: false });
  const r = await json('POST', '/v1/tag-vlm', { scope: 'review' });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /AI 增强/);
});
