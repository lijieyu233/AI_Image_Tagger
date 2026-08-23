import crypto from 'node:crypto';
import fs from 'node:fs';
import sharp from 'sharp';
import { toSharpInput } from './media.js';

// 文件哈希（sha256），流式读取避免大文件占满内存
export async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(filePath);
    s.on('data', (chunk) => hash.update(chunk));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return hash.digest('hex');
}

// 感知哈希（平均哈希 aHash）：8x8 灰度 -> 64 位十六进制（HEIC 也支持）
export async function aHash(filePath) {
  const { input, raw } = await toSharpInput(filePath);
  const s = raw ? sharp(input, { raw }) : sharp(input);
  const { data } = await s
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (const v of data) sum += v;
  const avg = sum / data.length;

  const bits = [];
  for (const v of data) bits.push(v >= avg ? '1' : '0');

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16);
  }
  return hex;
}

// 汉明距离
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16);
    const y = parseInt(b[i], 16);
    let v = x ^ y;
    while (v) { dist += v & 1; v >>= 1; }
  }
  return dist;
}
