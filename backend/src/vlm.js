// AI 增强打标（云端 VLM）：按原设计只做「难例加料」——默认关、只送选中的图、
// 输出只许从词表选（禁词扫描后入库，source=vlm）。没有 Key 时主路径完全不受影响。
import path from 'node:path';
import fs from 'node:fs';
import { THUMBS_DIR, loadTags, loadAppSettings, DEFAULT_THRESHOLD } from './config.js';
import { getDb, ensureTag, upsertTag, updateJob } from './db.js';

const PROVIDERS = {
  dashscope: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-vl-max', label: '阿里云百炼 Qwen-VL' },
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', label: 'OpenAI 兼容' },
};

// 隐私红线：默认不送云端的组（原设计：证件/发票默认不送）。可在设置里显式放开。
const PRIVACY_GROUPS = ['文档'];

export function aiConfig() {
  const s = (loadAppSettings().ai || {});
  const p = PROVIDERS[s.provider] || PROVIDERS.dashscope;
  return {
    provider: s.provider === 'openai' ? 'openai' : 'dashscope',
    baseUrl: (s.baseUrl || '').trim() || p.baseUrl,
    model: (s.model || '').trim() || p.defaultModel,
    apiKey: s.apiKey || '',
    enabled: !!s.enabled,
    allowPrivateGroups: !!s.allowPrivateGroups,
  };
}

export function aiReady() {
  const c = aiConfig();
  return !!(c.enabled && c.apiKey);
}

// 参与云端打标的组：auto、未被组开关关闭、且不在隐私红线内（除非显式放开）
export function eligibleGroups(vocab, { allowPrivateGroups = false } = {}) {
  return (vocab.groups || []).filter((g) =>
    g.kind === 'auto' && !g.disabled && (allowPrivateGroups || !PRIVACY_GROUPS.includes(g.name)));
}

// 组装提示词：词表受限 + 只输出 JSON（纯函数，便于测试）
export function buildVlmPrompt(groups) {
  const allowed = groups.flatMap((g) => g.tags.map((t) => `${t}（${g.name}）`));
  return [
    '你是图片标注助手。请从下面的候选标签中选出图片内容匹配的标签（1~6 个，宁缺毋滥）。',
    '只能从候选里选，禁止发明新词。只输出 JSON，格式：{"tags":["标签1","标签2"]}，不要输出其他内容。',
    '候选标签：',
    allowed.join('、'),
  ].join('\n');
}

// 解析模型返回：容忍 markdown 代码块包裹；只保留词表内的标签（禁词扫描），去重、限量 6 个（纯函数）
export function parseVlmTags(text, allowedNames) {
  const allowed = new Set(allowedNames);
  let raw = String(text || '').trim();
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (m) raw = m[1].trim();
  let tags = [];
  try {
    const obj = JSON.parse(raw);
    tags = Array.isArray(obj) ? obj : (Array.isArray(obj.tags) ? obj.tags : []);
  } catch {
    // 兜底：从文本里抠词表内出现的标签
    tags = allowedNames.filter((n) => raw.includes(n));
  }
  const out = [];
  for (const t of tags) {
    if (typeof t === 'string' && allowed.has(t.trim()) && !out.includes(t.trim())) out.push(t.trim());
    if (out.length >= 6) break;
  }
  return out;
}

function imageDataUrl(thumbPath) {
  const buf = fs.readFileSync(path.join(THUMBS_DIR, thumbPath));
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

async function chat(baseUrl, apiKey, model, userContent, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0.1,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return data?.choices?.[0]?.message?.content ?? '';
  } finally {
    clearTimeout(timer);
  }
}

// 连通性测试：发一条最小文本请求
export async function testConnection() {
  const c = aiConfig();
  if (!c.apiKey) throw new Error('未配置 API Key');
  const reply = await chat(c.baseUrl, c.apiKey, c.model, '回复“OK”两个字');
  return { ok: true, reply: String(reply).slice(0, 50) };
}

// 单图云端打分：返回 [{name, group}]（不落库）
export async function scorePhotoVlm(photoId) {
  const c = aiConfig();
  if (!c.apiKey) throw new Error('未配置 API Key，请先在设置里填写');
  const db = getDb();
  const photo = db.prepare('SELECT thumb_path FROM photos WHERE id = ?').get(photoId);
  if (!photo?.thumb_path) return [];

  const vocab = loadTags();
  const groups = eligibleGroups(vocab, c);
  const allowed = groups.flatMap((g) => g.tags);
  if (!allowed.length) return [];

  const content = [
    { type: 'text', text: buildVlmPrompt(groups) },
    { type: 'image_url', image_url: { url: imageDataUrl(photo.thumb_path) } },
  ];
  const reply = await chat(c.baseUrl, c.apiKey, c.model, content);
  const names = parseVlmTags(reply, allowed);
  const byName = new Map(groups.flatMap((g) => g.tags.map((t) => [t, g.name])));
  return names.map((name) => ({ name, group: byName.get(name) || '用途' }));
}

// 单图落库：清旧 vlm 标签后写入（confidence=1 表示人工/更强模型确认过）
export async function tagPhotoVlm(photoId) {
  const db = getDb();
  db.prepare(`DELETE FROM photo_tags WHERE photo_id = ? AND source = 'vlm'`).run(photoId);
  const tags = await scorePhotoVlm(photoId);
  for (const t of tags) {
    const tagId = ensureTag(t.name, t.group, 'auto');
    upsertTag(photoId, tagId, 'vlm', 1.0);
  }
  return tags.length;
}

// 批量（scope：'review'=待确认相册，'ids'=指定图）。jobId 非 null 时写回 jobs 表。
export async function tagVlmAll({ scope = 'review', ids = null, limit = 100 } = {}, jobId = null) {
  const db = getDb();
  let rows;
  if (Array.isArray(ids) && ids.length) {
    const ph = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT id FROM photos WHERE id IN (${ph}) AND status = 'ready'`).all(...ids);
  } else if (scope === 'review') {
    // 与 smart=review 同口径：有未驳回标签、无人工标签、存在低置信标签
    const threshold = loadTags().threshold ?? DEFAULT_THRESHOLD;
    rows = db.prepare(`
      SELECT p.id FROM photos p
      WHERE p.status = 'ready'
        AND EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.rejected = 0)
        AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source = 'manual')
        AND EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND (pt.confidence IS NULL OR pt.confidence < ?))
      ORDER BY p.id LIMIT ?`).all(threshold, limit);
  } else {
    rows = [];
  }

  if (jobId != null) updateJob(jobId, { total: rows.length, done: 0, status: 'running' });
  const startedAt = Date.now();
  console.log(`[vlm] AI 增强打标开始：${rows.length} 张（${scope}）`);

  let tagged = 0;
  const errors = [];
  for (let i = 0; i < rows.length; i++) {
    try {
      tagged += await tagPhotoVlm(rows[i].id);
    } catch (e) {
      errors.push(`photo ${rows[i].id}: ${e?.message ?? e}`);
      console.error(`[vlm] photo ${rows[i].id} 失败:`, e?.message ?? e);
    }
    if (jobId != null) updateJob(jobId, { done: i + 1 });
  }
  const stats = { processed: rows.length, tagged, seconds: Math.round((Date.now() - startedAt) / 100) / 10, scope };
  const status = errors.length ? 'done_with_errors' : 'done';
  if (jobId != null) updateJob(jobId, { status, error: errors[0] || null, stats: JSON.stringify(stats) });
  console.log(`[vlm] AI 增强打标完成：处理 ${rows.length}，标签 ${tagged}，耗时 ${stats.seconds}s`);
  return { processed: rows.length, tagged, errors: errors.slice(0, 10), jobId, stats };
}
