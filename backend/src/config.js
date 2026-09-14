import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 项目根目录 = backend/src 上两级
// 打包后可用环境变量覆盖数据/配置/前端目录（见 electron/main.cjs）
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export const DATA_DIR = process.env.TAGGER_DATA_DIR || path.join(PROJECT_ROOT, 'data');
export const DB_PATH = process.env.TAGGER_DB_PATH || path.join(DATA_DIR, 'library.db');
export const THUMBS_DIR = process.env.TAGGER_THUMBS_DIR || path.join(DATA_DIR, 'thumbs');
export const INBOX_DIR = process.env.TAGGER_INBOX_DIR || path.join(DATA_DIR, 'inbox');
export const TAGS_FILE = process.env.TAGGER_TAGS_FILE || path.join(PROJECT_ROOT, 'config', 'tags.json');
// 应用级设置（AI Provider / API Key 等），存数据目录，不入 git
export const SETTINGS_FILE = process.env.TAGGER_SETTINGS_FILE || path.join(DATA_DIR, 'settings.json');

export const PORT = process.env.PORT ? Number(process.env.PORT) : 47910;
export const HOST = '127.0.0.1';

// 默认打标阈值（config/tags.json 缺 threshold 时的回退）。
// server/clip/vlm 三处统一引用，避免回退值各写各的（历史曾出现 0.22/0.24/0.25 三套）。
export const DEFAULT_THRESHOLD = 0.25;

// 支持的文件扩展名（HEIC 第一期标注为待支持）
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
export const HEIC_EXTS = new Set(['.heic', '.heif']);
// 视频暂不支持（导入时计数并明确提示，而不是静默忽略）
export const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v', '.3gp']);

// 缩略图长边像素
export const THUMB_SIZE = 320;

export function ensureDirs() {
  for (const d of [DATA_DIR, THUMBS_DIR, INBOX_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

export function loadTags() {
  const raw = fs.readFileSync(TAGS_FILE, 'utf8');
  return JSON.parse(raw);
}

export function loadAppSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

export function saveAppSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2) + '\n');
}
