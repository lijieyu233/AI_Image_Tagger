import path from 'node:path';
import {
  env, RawImage, AutoTokenizer, AutoProcessor,
  CLIPTextModelWithProjection, CLIPVisionModelWithProjection,
} from '@xenova/transformers';
import { DATA_DIR, THUMBS_DIR, loadTags } from './config.js';
import { getDb, ensureTag, upsertTag, rejectCounts } from './db.js';

env.cacheDir = path.join(DATA_DIR, 'models');
env.allowLocalModels = false;
// 国内直连 HuggingFace 常超时，默认走镜像；可设 HF_ENDPOINT 覆盖
env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';

const MODEL = 'Xenova/clip-vit-base-patch32';

let modelsPromise = null;
let textEmbeddings = null;   // { name: Float32Array(normalized) }
let vocabSnapshot = null;

async function getModels() {
  if (!modelsPromise) {
    modelsPromise = (async () => {
      const [tokenizer, processor, textModel, visionModel] = await Promise.all([
        AutoTokenizer.from_pretrained(MODEL),
        AutoProcessor.from_pretrained(MODEL),
        CLIPTextModelWithProjection.from_pretrained(MODEL, { quantized: true }),
        CLIPVisionModelWithProjection.from_pretrained(MODEL, { quantized: true }),
      ]);
      return { tokenizer, processor, textModel, visionModel };
    })().catch((e) => { modelsPromise = null; throw e; });
  }
  return modelsPromise;
}

function l2normalize(arr) {
  let s = 0;
  for (const v of arr) s += v * v;
  s = Math.sqrt(s) || 1;
  return arr.map((v) => v / s);
}

async function buildTextEmbeddings() {
  if (textEmbeddings) return textEmbeddings;
  const vocab = loadTags();
  const prompts = vocab.prompts || {};
  const names = Object.keys(prompts);
  const { tokenizer, textModel } = await getModels();

  const inputs = tokenizer(names.map((n) => prompts[n]), { padding: true, truncation: true });
  const out = await textModel(inputs);
  const dim = out.text_embeds.dims[out.text_embeds.dims.length - 1];

  textEmbeddings = {};
  names.forEach((name, i) => {
    const raw = Array.from(out.text_embeds.data.slice(i * dim, (i + 1) * dim));
    textEmbeddings[name] = l2normalize(raw);
  });
  vocabSnapshot = vocab;
  return textEmbeddings;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// 给单张图打分，返回 [{name, group, score}]（cosine 相似度）
export async function scorePhoto(thumbPath) {
  const te = await buildTextEmbeddings();
  const { processor, visionModel } = await getModels();
  const image = await RawImage.read(thumbPath);
  const inputs = await processor(image);
  const out = await visionModel(inputs);
  const dim = out.image_embeds.dims[out.image_embeds.dims.length - 1];
  const img = l2normalize(Array.from(out.image_embeds.data.slice(0, dim)));

  const vocab = vocabSnapshot;
  const baseThreshold = vocab.threshold ?? 0.24;
  const rejects = rejectCounts();
  const promptNames = new Set(Object.keys(vocab.prompts || {}));

  const scores = [];
  for (const g of vocab.groups) {
    if (g.kind !== 'auto') continue;
    const mutex = new Set(g.mutex || []);
    const groupScores = [];
    for (const name of g.tags) {
      if (!promptNames.has(name) || !te[name]) continue;
      // 被人手驳回过就抬高阈值（每个驳回 +0.008，上限 +0.08）
      const offset = Math.min((rejects[name] || 0) * 0.008, 0.08);
      const threshold = baseThreshold + offset;
      const s = dot(img, te[name]);
      if (s >= threshold) groupScores.push({ name, group: g.name, score: s });
    }
    // 互斥组只留最高分
    if (mutex.size) {
      const mutexNames = groupScores.filter((x) => mutex.has(x.name));
      if (mutexNames.length) {
        const best = mutexNames.reduce((a, b) => (a.score >= b.score ? a : b));
        const kept = groupScores.filter((x) => !mutex.has(x.name));
        kept.push(best);
        groupScores.length = 0;
        groupScores.push(...kept);
      }
    }
    groupScores.sort((a, b) => b.score - a.score);
    scores.push(...groupScores.slice(0, 3));
  }
  return scores;
}

// 给单张图落库 clip 标签
export async function tagPhoto(photoId) {
  const db = getDb();
  const photo = db.prepare('SELECT id, thumb_path FROM photos WHERE id = ?').get(photoId);
  if (!photo || !photo.thumb_path) return 0;
  const thumbPath = path.join(THUMBS_DIR, photo.thumb_path);
  const scores = await scorePhoto(thumbPath);
  for (const s of scores) {
    const tagId = ensureTag(s.name, s.group, 'auto');
    upsertTag(photoId, tagId, 'clip', s.score);
  }
  return scores.length;
}

// 单图重新分类：清除已有 clip 标签后重跑（返回新命中的标签数）
export async function reclassifyPhoto(photoId) {
  const db = getDb();
  db.prepare(`DELETE FROM photo_tags WHERE photo_id = ? AND source = 'clip'`).run(photoId);
  return tagPhoto(photoId);
}

// 批量：给尚无 clip 标签的图打标。limit 限制本次处理数量。
export async function tagAll(limit = 200) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.id FROM photos p
    WHERE p.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source = 'clip')
    ORDER BY p.id LIMIT ?`).all(limit);

  let tagged = 0;
  const errors = [];
  for (const r of rows) {
    try {
      tagged += await tagPhoto(r.id);
    } catch (e) {
      errors.push(`photo ${r.id}: ${e?.message ?? e}`);
    }
  }
  return { processed: rows.length, tagged, errors: errors.slice(0, 10) };
}
