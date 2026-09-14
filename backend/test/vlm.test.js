// AI 增强（云端 VLM）单元测试：不真实联网，mock fetch 验证提示词组装、响应解析、
// 白名单禁词扫描、隐私组排除。真实联调需要用户配置 Key 后在设置页「测试连接」。
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 隔离数据目录（settings.json 会写在这里；必须在 import 业务模块前设好 env）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tagger-vlm-'));
process.env.TAGGER_DATA_DIR = path.join(tmp, 'data');
process.env.TAGGER_SETTINGS_FILE = path.join(tmp, 'data', 'settings.json');
process.env.TAGGER_DB_PATH = path.join(tmp, 'data', 'library.db');
process.env.TAGGER_THUMBS_DIR = path.join(tmp, 'thumbs');

let vlm;

before(async () => {
  vlm = await import('../src/vlm.js');
});

const GROUPS = [
  { name: '场景', kind: 'auto', tags: ['室内', '室外', '风景'] },
  { name: '物品', kind: 'auto', disabled: true, tags: ['猫', '狗'] },
  { name: '文档', kind: 'auto', tags: ['发票', '身份证'] },
  { name: '来源', kind: 'system', tags: ['截图'] },
];

test('eligibleGroups：只要 auto、跳过关闭组、默认排除隐私组（可放开）', () => {
  const g = vlm.eligibleGroups({ groups: GROUPS }, {});
  assert.deepEqual(g.map((x) => x.name), ['场景']);
  const open = vlm.eligibleGroups({ groups: GROUPS }, { allowPrivateGroups: true });
  assert.deepEqual(open.map((x) => x.name).sort(), ['场景', '文档']);
});

test('buildVlmPrompt：包含候选标签并要求只输出 JSON', () => {
  const p = vlm.buildVlmPrompt([{ name: '场景', kind: 'auto', tags: ['室内', '风景'] }]);
  assert.ok(p.includes('室内'), '包含标签');
  assert.ok(p.includes('{"tags'), '要求 JSON 格式');
  assert.ok(p.includes('禁止发明新词'), '词表受限声明');
});

test('parseVlmTags：干净 JSON', () => {
  const out = vlm.parseVlmTags('{"tags":["室内","风景"]}', ['室内', '风景', '猫']);
  assert.deepEqual(out, ['室内', '风景']);
});

test('parseVlmTags：容忍 markdown 代码块', () => {
  const out = vlm.parseVlmTags('好的，结果如下：\n```json\n{"tags":["猫"]}\n```', ['猫']);
  assert.deepEqual(out, ['猫']);
});

test('parseVlmTags：非 JSON 文本兜底（只抠词表内的词）', () => {
  const out = vlm.parseVlmTags('这张图看起来像 风景，也可能是 胡说八道', ['风景', '室内']);
  assert.deepEqual(out, ['风景']);
});

test('parseVlmTags：禁词扫描 + 去重 + 上限 6 个', () => {
  const out = vlm.parseVlmTags(
    '{"tags":["猫","发明的新词","猫","室内","风景","狗","花","车"]}',
    ['猫', '室内', '风景', '狗', '花', '车', '店']);
  assert.deepEqual(out, ['猫', '室内', '风景', '狗', '花', '车']);
});

test('aiConfig：无配置时默认 dashscope + 默认模型，未启用', () => {
  const c = vlm.aiConfig();
  assert.equal(c.provider, 'dashscope');
  assert.equal(c.model, 'qwen-vl-max');
  assert.equal(c.enabled, false);
  assert.equal(c.apiKey, '');
  assert.equal(vlm.aiReady(), false);
});

test('scorePhotoVlm：未配置 Key 时给出明确错误', async () => {
  await assert.rejects(() => vlm.scorePhotoVlm(1), /未配置 API Key/);
});

test('chat 解析：mock fetch 返回 choices.content（走 tagVlmAll 的解析路径）', async () => {
  // 临时塞入假设置 + mock 全局 fetch
  const settingsPath = process.env.TAGGER_SETTINGS_FILE;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ ai: { provider: 'dashscope', apiKey: 'sk-test', enabled: true } }));

  let calledUrl = '';
  globalThis.fetch = async (url, opts) => {
    calledUrl = url;
    const body = JSON.parse(opts.body);
    assert.ok(body.messages[0].content[1].image_url.url.startsWith('data:image/jpeg'), '图片以 data URL 上送');
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"tags":["室内"]}' } }] }),
      text: async () => '',
    };
  };

  // 准备一张带缩略图的照片（直接用临时目录伪造 thumbs）
  const { getDb } = await import('../src/db.js');
  const db = getDb();
  db.prepare(`INSERT INTO photos (path, file_hash, imported_at, thumb_path, status)
              VALUES ('x.jpg', 'h1', '2026-01-01', 'fake.jpg', 'ready')`).run();
  const photoId = db.prepare('SELECT id FROM photos WHERE file_hash = ?').get('h1').id;
  fs.mkdirSync(process.env.TAGGER_THUMBS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.TAGGER_THUMBS_DIR, 'fake.jpg'), Buffer.from('fakejpeg'));

  const n = await vlm.tagPhotoVlm(photoId);
  assert.equal(n, 1);
  assert.ok(calledUrl.includes('/chat/completions'), '请求 OpenAI 兼容端点');
  const row = db.prepare('SELECT source, confidence FROM photo_tags WHERE photo_id = ?').get(photoId);
  assert.equal(row.source, 'vlm');
  assert.equal(row.confidence, 1);
});
