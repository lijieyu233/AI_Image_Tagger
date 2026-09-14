import path from 'node:path';
import fs from 'node:fs';
import {
  env, RawImage, AutoTokenizer, AutoProcessor,
  CLIPTextModelWithProjection, CLIPVisionModelWithProjection,
} from '@xenova/transformers';
import { DATA_DIR, THUMBS_DIR, loadTags, TAGS_FILE, DEFAULT_THRESHOLD } from './config.js';
import { getDb, ensureTag, upsertTag, rejectCounts, updateJob } from './db.js';
import { decideTags, applyMutex, calibrateThresholds, summaryStats } from './tagging.js';

env.cacheDir = path.join(DATA_DIR, 'models');
env.allowLocalModels = false;
// 国内直连 HuggingFace 常超时，默认走镜像；可设 HF_ENDPOINT 覆盖
env.remoteHost = process.env.HF_ENDPOINT || 'https://hf-mirror.com';

const MODEL = 'Xenova/clip-vit-base-patch32';
// 低于该样本量不做阈值自动校准（也避免测试环境污染 config/tags.json）
const MIN_CALIBRATE_PHOTOS = 25;

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

// 词表文件 mtime 跟踪：编辑 config/tags.json（阈值/提示句）后，下次打标自动生效，无需重启。
let tagsMtime = -1;
function tagsFileChanged() {
  try {
    const m = fs.statSync(TAGS_FILE).mtimeMs;
    if (textEmbeddings && m === tagsMtime) return false;
    tagsMtime = m;
    return true;
  } catch {
    return false;
  }
}

// 文本嵌入（prompt ensemble）：每个标签可配置多句英文提示（数组），取嵌入均值再归一化，
// 比单句提示判别力更稳。句子兼容旧格式（字符串 = 单句）。
async function buildTextEmbeddings() {
  if (textEmbeddings && !tagsFileChanged()) return textEmbeddings;
  const vocab = loadTags();
  const prompts = vocab.prompts || {};
  const names = Object.keys(prompts);
  const sentences = names.map((n) => (Array.isArray(prompts[n]) ? prompts[n] : [prompts[n]]));
  const flat = sentences.flat();
  const { tokenizer, textModel } = await getModels();

  const inputs = tokenizer(flat, { padding: true, truncation: true });
  const out = await textModel(inputs);
  const dim = out.text_embeds.dims[out.text_embeds.dims.length - 1];

  // 按句子索引切片 → 标签内取均值 → 归一化
  const perSentence = flat.map((_, i) =>
    Array.from(out.text_embeds.data.slice(i * dim, (i + 1) * dim)));
  textEmbeddings = {};
  let cursor = 0;
  names.forEach((name, i) => {
    const ss = sentences[i];
    const dimSum = new Array(dim).fill(0);
    for (const raw of perSentence.slice(cursor, cursor + ss.length)) {
      for (let d = 0; d < dim; d++) dimSum[d] += raw[d];
    }
    cursor += ss.length;
    textEmbeddings[name] = l2normalize(dimSum.map((v) => v / ss.length));
  });
  vocabSnapshot = vocab;
  return textEmbeddings;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// 给单张图打分。
// 返回 { tags, review, top, groupMax }：
//  - tags：确认落库的标签；review：待审标签（低于阈值但在窗口内，供人工确认）；
//  - top：全部候选按分数降序前 5（含各自有效阈值），用于界面调试展示；
//  - groupMax：每个 auto 组内的最高分（供批量跑完后自动校准每组阈值）。
export async function scorePhoto(thumbPath) {
  const te = await buildTextEmbeddings();
  const { processor, visionModel } = await getModels();
  const image = await RawImage.read(thumbPath);
  const inputs = await processor(image);
  const out = await visionModel(inputs);
  const dim = out.image_embeds.dims[out.image_embeds.dims.length - 1];
  const img = l2normalize(Array.from(out.image_embeds.data.slice(0, dim)));

  const vocab = vocabSnapshot;
  const baseThreshold = vocab.threshold ?? DEFAULT_THRESHOLD;
  const rejects = rejectCounts();
  const promptNames = new Set(Object.keys(vocab.prompts || {}));

  // 构建候选：有效阈值 = 组阈值（缺省用全局）+ 人工驳回抬升量
  const candidates = [];
  const groupMax = [];
  for (const g of vocab.groups) {
    if (g.kind !== 'auto' || g.disabled) continue; // 组开关：关闭的组模型不再自动打标
    const groupThreshold = g.threshold ?? baseThreshold;
    let groupCandidates = [];
    for (const name of g.tags) {
      if (!promptNames.has(name) || !te[name]) continue;
      // 被人手驳回过就抬高阈值（每个驳回 +0.008，上限 +0.08）
      const offset = Math.min((rejects[name] || 0) * 0.008, 0.08);
      groupCandidates.push({ name, group: g.name, score: dot(img, te[name]), threshold: groupThreshold + offset });
    }
    groupCandidates = applyMutex(groupCandidates, g.mutex);
    if (groupCandidates.length) {
      candidates.push(...groupCandidates);
      groupMax.push({ group: g.name, score: Math.max(...groupCandidates.map((c) => c.score)) });
    }
  }

  const { tags, review } = decideTags(candidates);
  const top = [...candidates].sort((a, b) => b.score - a.score).slice(0, 5);
  return { tags, review, top, groupMax };
}

// 给单张图落库 clip 标签（含待审标签：confidence < 阈值自然进入「待复核」智能相册）
export async function tagPhoto(photoId) {
  const db = getDb();
  const photo = db.prepare('SELECT id, thumb_path FROM photos WHERE id = ?').get(photoId);
  if (!photo || !photo.thumb_path) return { tagged: 0, review: 0, top: [], groupMax: [] };
  const thumbPath = path.join(THUMBS_DIR, photo.thumb_path);
  const r = await scorePhoto(thumbPath);
  for (const s of [...r.tags, ...r.review]) {
    const tagId = ensureTag(s.name, s.group, 'auto');
    upsertTag(photoId, tagId, 'clip', s.score);
  }
  return { tagged: r.tags.length, review: r.review.length, top: r.top, groupMax: r.groupMax, kept: [...r.tags, ...r.review] };
}

// 单图重新分类：清除已有 clip 标签后重跑（返回新命中的标签数）
export async function reclassifyPhoto(photoId) {
  const db = getDb();
  db.prepare(`DELETE FROM photo_tags WHERE photo_id = ? AND source = 'clip'`).run(photoId);
  return tagPhoto(photoId);
}

// 阈值自动校准：按各组「每图最高分」分布的 P60 推荐每组阈值，写回 config/tags.json。
// 组内已有 threshold_manual: true 的不覆盖；样本量不足 MIN_CALIBRATE_PHOTOS 时跳过。
function autoCalibrate(groupMaxSamples) {
  const recommended = calibrateThresholds(groupMaxSamples, { minSamples: MIN_CALIBRATE_PHOTOS });
  if (!Object.keys(recommended).length) return null;
  try {
    const vocab = JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8'));
    let changed = false;
    for (const g of vocab.groups) {
      if (g.kind !== 'auto' || g.threshold_manual || g.disabled) continue;
      const t = recommended[g.name];
      if (t != null && g.threshold !== t) { g.threshold = t; changed = true; }
    }
    if (!changed) return recommended;
    vocab.thresholds_auto = true;
    fs.writeFileSync(TAGS_FILE, JSON.stringify(vocab, null, 2) + '\n');
    tagsMtime = -1; // 使嵌入/快照缓存失效，下次打标用新阈值
    console.log(`[clip] 阈值自动校准完成：${JSON.stringify(recommended)}`);
  } catch (e) {
    console.error('[clip] 阈值自动校准写入失败:', e?.message ?? e);
  }
  return recommended;
}

// 批量：给尚无 clip 标签的图打标。limit 限制本次处理数量。
// jobId 非 null 时把进度与统计写回 jobs 表，供前端轮询。
export async function tagAll(limit = 200, jobId = null) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.id FROM photos p
    WHERE p.status = 'ready'
      AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source = 'clip')
    ORDER BY p.id LIMIT ?`).all(limit);

  if (jobId != null) updateJob(jobId, { total: rows.length, done: 0, status: 'running' });
  const startedAt = Date.now();
  console.log(`[clip] 批量打标开始：${rows.length} 张`);

  let tagged = 0;
  let review = 0;
  const errors = [];
  const groupMaxSamples = [];
  const tagHits = {};
  const emittedScores = [];

  for (let i = 0; i < rows.length; i++) {
    try {
      const r = await tagPhoto(rows[i].id);
      tagged += r.tagged;
      review += r.review;
      groupMaxSamples.push(...r.groupMax);
      for (const s of r.kept || []) {
        tagHits[s.name] = (tagHits[s.name] || 0) + 1;
        emittedScores.push(s.score);
      }
    } catch (e) {
      errors.push(`photo ${rows[i].id}: ${e?.message ?? e}`);
      console.error(`[clip] photo ${rows[i].id} 打标失败:`, e?.message ?? e);
    }
    if (jobId != null) updateJob(jobId, { done: i + 1 });
  }

  const calibrated = autoCalibrate(groupMaxSamples);
  const stats = {
    processed: rows.length,
    tagged,
    review,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    tagHits,
    score: summaryStats(emittedScores),
    calibrated,
  };
  const status = errors.length ? 'done_with_errors' : 'done';
  if (jobId != null) updateJob(jobId, { status, error: errors[0] || null, stats: JSON.stringify(stats) });
  console.log(`[clip] 批量打标完成：处理 ${stats.processed}，标签 ${tagged}，待审 ${review}，耗时 ${stats.seconds}s`);
  return { processed: rows.length, tagged, review, errors: errors.slice(0, 10), jobId, stats };
}
