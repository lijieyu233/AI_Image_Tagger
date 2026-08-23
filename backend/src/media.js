import path from 'node:path';
import fs from 'node:fs';
import sharp from 'sharp';
import exifr from 'exifr';
import decode from 'heic-decode';
import { THUMBS_DIR, THUMB_SIZE } from './config.js';

const HEIC = new Set(['.heic', '.heif']);

// 统一图像入口：HEIC 先解码成 RGBA，其余直接给 sharp。
// 返回 { input, raw, width, height }，raw 用于 sharp 的 raw 输入。
export async function toSharpInput(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (HEIC.has(ext)) {
    const buf = await fs.promises.readFile(filePath);
    const { width, height, data } = await decode({ buffer: buf });
    return { input: data, raw: { width, height, channels: 4 }, width, height };
  }
  const meta = await sharp(filePath).metadata();
  return { input: filePath, raw: null, width: meta.width || 0, height: meta.height || 0 };
}

function toSharp({ input, raw }) {
  return raw ? sharp(input, { raw }) : sharp(input);
}

// 读 EXIF：拍摄时间 / 机型 / GPS。没有就回退文件时间。
export async function readMeta(filePath) {
  let exif = {};
  try {
    exif = await exifr.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model'],
    });
  } catch { /* 无 EXIF 或不支持 */ }

  let gps = null;
  try {
    gps = await exifr.gps(filePath);
  } catch { /* 无 GPS */ }

  const stat = fs.statSync(filePath);
  const takenRaw = exif?.DateTimeOriginal || exif?.CreateDate || null;
  const takenAt = takenRaw ? toIso(takenRaw) : stat.mtime.toISOString();
  const timeApprox = !takenRaw;

  return {
    takenAt,
    timeApprox,
    camera: exif?.Make ? `${exif.Make} ${exif.Model ?? ''}`.trim() : null,
    gpsLat: gps?.latitude ?? null,
    gpsLon: gps?.longitude ?? null,
    bytes: stat.size,
  };
}

function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  const m = String(v).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).toISOString();
  const d = new Date(v);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

// 出缩略图（长边 THUMB_SIZE，转 jpg）。返回相对 thumb 文件路径。
export async function makeThumb(filePath, photoId) {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
  const name = `${photoId}.jpg`;
  const out = path.join(THUMBS_DIR, name);
  const { input, raw } = await toSharpInput(filePath);
  await toSharp({ input, raw })
    .rotate()
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toFile(out);
  return name;
}

// 读尺寸（HEIC 也支持）
export async function readSize(filePath) {
  try {
    const { width, height } = await toSharpInput(filePath);
    return { width, height };
  } catch {
    return { width: 0, height: 0 };
  }
}
