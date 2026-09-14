import path from 'node:path';
import fs from 'node:fs';
import { getDb, ensureTag, upsertTag } from './db.js';
import { sha256File, aHash } from './hashing.js';
import { readMeta, makeThumb, readSize } from './media.js';
import { IMAGE_EXTS, HEIC_EXTS, VIDEO_EXTS, THUMBS_DIR } from './config.js';

// 规则标：来源/形式，不耗模型
export function ruleTags(fullPath, width, height) {
  const p = fullPath.toLowerCase();
  const tags = new Set();

  if (p.includes('screenshot') || p.includes('screen')) tags.add('截图');
  if (p.includes('weixin') || p.includes('wechat') || p.includes('mmexport')) tags.add('微信');
  if (p.includes('scan') || p.includes('扫描') || p.includes('证件')) tags.add('证件扫描');

  if (width > 0 && height > 0) {
    const ratio = width / height;
    if (ratio > 2.5 || ratio < 0.4) tags.add('全景');
  }
  return [...tags];
}

export function isImage(file) {
  const ext = path.extname(file).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'ok';
  if (HEIC_EXTS.has(ext)) return 'heic';
  return null;
}

// 递归列出目录下所有图片；同时统计视频数量（暂不支持，导入结果里明确提示而不是静默忽略）
export async function listImages(dir) {
  if (!fs.existsSync(dir)) return { items: [], videos: 0 };
  const entries = await fs.promises.readdir(dir, { recursive: true });
  const items = [];
  let videos = 0;
  for (const rel of entries) {
    const full = path.join(dir, rel);
    let stat;
    try { stat = await fs.promises.stat(full); } catch { continue; }
    if (!stat.isFile()) continue;
    const ext = path.extname(rel).toLowerCase();
    if (VIDEO_EXTS.has(ext)) { videos++; continue; }
    const kind = isImage(rel);
    if (kind) {
      const parts = rel.split(path.sep);
      const sourceDir = parts.length > 1 ? parts[0] : path.basename(dir);
      items.push({ full, rel, sourceDir, kind });
    }
  }
  return { items, videos };
}

// 处理单个文件，返回 { photoId, status, error }
export async function importFile(fullPath, sourceDir) {
  const db = getDb();
  const stat = fs.statSync(fullPath);

  // 已入库（按路径）：内容相同跳过；内容变化则原地更新
  const existing = db.prepare('SELECT id, file_hash, thumb_path FROM photos WHERE path = ?').get(fullPath);
  const fileHash = await sha256File(fullPath);

  let photoId;
  let isUpdate = false;
  if (existing) {
    if (existing.file_hash === fileHash) return { photoId: existing.id, status: 'skip' };
    isUpdate = true;
    photoId = existing.id;
  }

  // 按文件哈希去重：不同路径但内容相同
  const byHash = db.prepare('SELECT id FROM photos WHERE file_hash = ?').get(fileHash);
  if (byHash && !isUpdate) return { photoId: byHash.id, status: 'dup' };

  const meta = await readMeta(fullPath);
  let width = 0, height = 0;
  let phash = null;
  let thumbPath = null;

  try {
    const size = await readSize(fullPath);
    width = size.width; height = size.height;
  } catch { /* 坏图 */ }

  if (!isUpdate) {
    const ins = db.prepare(`
      INSERT INTO photos
        (path, file_hash, phash, bytes, width, height, taken_at, imported_at,
         camera, gps_lat, gps_lon, source_dir, thumb_path, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready')
    `);
    const info = ins.run(
      fullPath, fileHash, phash, stat.size, width, height,
      meta.takenAt, new Date().toISOString(),
      meta.camera, meta.gpsLat, meta.gpsLon, sourceDir, thumbPath,
    );
    photoId = Number(info.lastInsertRowid);
  } else {
    // 原地更新：刷新元数据，清掉旧的自动/规则标签（保留人工标签），删旧缩略图
    db.prepare(`
      UPDATE photos SET file_hash=?, bytes=?, width=?, height=?, taken_at=?,
        camera=?, gps_lat=?, gps_lon=?, source_dir=?, status='ready', thumb_path=NULL
      WHERE id=?
    `).run(fileHash, stat.size, width, height, meta.takenAt,
           meta.camera, meta.gpsLat, meta.gpsLon, sourceDir, photoId);
    db.prepare(`DELETE FROM photo_tags WHERE photo_id=? AND source IN ('rule','clip')`).run(photoId);
    if (existing.thumb_path) {
      try { fs.unlinkSync(path.join(THUMBS_DIR, existing.thumb_path)); } catch { /* 已不存在 */ }
    }
  }

  try {
    thumbPath = await makeThumb(fullPath, photoId);
    db.prepare('UPDATE photos SET thumb_path = ? WHERE id = ?').run(thumbPath, photoId);
  } catch (e) {
    db.prepare("UPDATE photos SET status = 'failed' WHERE id = ?").run(photoId);
    return { photoId, status: 'failed', error: String(e?.message ?? e) };
  }

  // 感知哈希（生成缩略图之后算，避免坏图重复解码）
  try {
    phash = await aHash(fullPath);
    db.prepare('UPDATE photos SET phash = ? WHERE id = ?').run(phash, photoId);
  } catch { /* 个别图算不了 */ }

  // 规则标
  for (const name of ruleTags(fullPath, width, height)) {
    const tagId = ensureTag(name, '来源/形式', 'system');
    upsertTag(photoId, tagId, 'rule', 1.0);
  }
  // 来源目录标
  if (sourceDir) {
    const tagId = ensureTag(sourceDir, '来源', 'system');
    upsertTag(photoId, tagId, 'rule', 1.0);
  }

  return { photoId, status: isUpdate ? 'updated' : 'new' };
}

// 全量导入一个目录，返回统计
export async function runImport(dir) {
  const db = getDb();
  const { items: files, videos } = await listImages(dir);
  const job = db.prepare('INSERT INTO jobs (type, status, total, done) VALUES (?, ?, ?, 0)')
    .run('import', 'running', files.length);
  const jobId = Number(job.lastInsertRowid);

  const stats = { total: files.length, new: 0, updated: 0, dup: 0, skip: 0, failed: 0, heic: 0, video: videos };
  const failed = [];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const r = await importFile(f.full, f.sourceDir);
      stats[r.status] = (stats[r.status] || 0) + 1;
    } catch (e) {
      stats.failed++;
      failed.push(`${f.rel}: ${e?.message ?? e}`);
    }
    db.prepare('UPDATE jobs SET done = ? WHERE id = ?').run(i + 1, jobId);
  }

  const status = stats.failed > 0 ? 'done_with_errors' : 'done';
  db.prepare('UPDATE jobs SET status = ? WHERE id = ?').run(status, jobId);
  return { jobId, stats, failed: failed.slice(0, 20) };
}
