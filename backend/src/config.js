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

export const PORT = 47910;
export const HOST = '127.0.0.1';

// 支持的文件扩展名（HEIC 第一期标注为待支持）
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
export const HEIC_EXTS = new Set(['.heic', '.heif']);

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
