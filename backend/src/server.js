import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { getDb, syncVocab, ensureTag, upsertTag, deletePhotoTag, rejectTag, updateJob, getJob } from './db.js';
import { runImport } from './import.js';
import { INBOX_DIR, PROJECT_ROOT, THUMBS_DIR, DATA_DIR, loadTags, loadAppSettings, saveAppSettings, PORT, HOST, DEFAULT_THRESHOLD } from './config.js';
import { hamming } from './hashing.js';

const WEB_DIST = process.env.TAGGER_WEB_DIST || path.join(PROJECT_ROOT, 'web', 'dist');

// 当前正在跑的打标任务 jobId（防止并发推理）
let currentTagJob = null;
let currentVlmJob = null;

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, maxBytes = 50 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      data += c;
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// 当前打标阈值（config/tags.json 的 threshold，缺省 DEFAULT_THRESHOLD），供筛选/统计共用
function getThreshold() {
  try { return loadTags().threshold ?? DEFAULT_THRESHOLD; } catch { return DEFAULT_THRESHOLD; }
}

// 每组有效阈值（来自 config/tags.json 的 group.threshold），用于「待确认」判定——
// 必须用打标决策时的同一口径（每组阈值 0.214~0.231），不能用全局阈值，否则已过本组阈值的
// 确认标签会被误判进「待确认」。返回可直接内联进 SQL 的 CASE 表达式（阈值为字面量，无注入风险：组名已转义）。
function groupThresholdCase() {
  const vocab = loadTags();
  const parts = [];
  for (const g of vocab.groups || []) {
    if (g.kind === 'auto' && typeof g.threshold === 'number') {
      const name = String(g.name).replace(/'/g, "''");
      parts.push(`WHEN '${name}' THEN ${g.threshold}`);
    }
  }
  return `CASE t.group_name ${parts.join(' ')} ELSE ${DEFAULT_THRESHOLD} END`;
}

// 「待确认」相册的判定子句：存在未驳回的 clip/vlm 标签且其分数低于该组有效阈值，且无人工标签。
function reviewClause() {
  const caseSql = groupThresholdCase();
  return `EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
              WHERE pt.photo_id = p.id AND pt.source IN ('clip','vlm') AND pt.rejected = 0
                AND (pt.confidence IS NULL OR pt.confidence < ${caseSql}))
          AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source = 'manual')`;
}

function serveFile(res, filePath, contentType) {
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404); res.end('not found'); return;
  }
  // 读入内存后一次性写回：避免流式 pipe 在异步阶段被静默截断（曾导致缩略图返回 0 字节）。
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      console.error('[serveFile] read error:', filePath, err?.message);
      if (!res.headersSent) { res.writeHead(500); }
      res.end('read error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'max-age=31536000, immutable',
    });
    res.end(buf);
  });
}

// 弹出 Windows 原生文件夹选择器，返回选中的路径（取消返回 null）
function pickFolder() {
  return new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$owner = New-Object System.Windows.Forms.Form",
      "$owner.TopMost = $true",
      "$owner.ShowInTaskbar = $false",
      "$owner.Opacity = 0",
      "$dlg = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dlg.Description = '选择图片所在的文件夹'",
      "$dlg.ShowNewFolderButton = $true",
      "if ($dlg.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($dlg.SelectedPath) }",
      "$owner.Dispose()",
    ].join('; ');
    // 写临时 .ps1（带 UTF-8 BOM，避免中文乱码）
    const tmp = path.join(os.tmpdir(), `tagger-pick-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
    try {
      fs.writeFileSync(tmp, '\uFEFF' + script, 'utf8');
      execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', tmp],
        { timeout: 300000, windowsHide: true },
        (err, stdout) => {
          const lines = (stdout || '').trim().split(/\r?\n/);
          const out = lines[lines.length - 1]?.trim();
          resolve(out || null);
        });
    } catch {
      resolve(null);
    }
  });
}

// 读取完整请求体（二进制），带体积上限
async function readRaw(req, maxBytes = 200 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) { req.destroy(); throw new Error('request body too large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// 极简 multipart/form-data 解析（仅本地使用，支持带 filename 的字段）
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) throw new Error('multipart 缺少 boundary');
  const boundary = (m[1] || m[2]).trim();
  const delimiter = Buffer.from('--' + boundary);
  const parts = [];
  let idx = buffer.indexOf(delimiter);
  while (idx !== -1) {
    const start = idx + delimiter.length;
    const next = buffer.indexOf(delimiter, start);
    if (next === -1) break;
    let seg = buffer.subarray(start, next);
    if (seg[0] === 0x0d && seg[1] === 0x0a) seg = seg.subarray(2);
    const sepIdx = seg.indexOf('\r\n\r\n');
    if (sepIdx === -1) { idx = next; continue; }
    const headerStr = seg.subarray(0, sepIdx).toString('utf8');
    let body = seg.subarray(sepIdx + 4);
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 2);
    }
    const disp = /name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(headerStr);
    const ct = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);
    parts.push({
      name: disp?.[1] || '',
      filename: disp?.[2],
      contentType: ct?.[1]?.trim(),
      buffer: body,
    });
    idx = next;
  }
  return parts;
}

// ---- 筛选构建 ----
function buildFilter(q) {
  const db = getDb();
  const where = ["p.status != 'failed'"];
  const params = [];

  const tags = q.tags ? String(q.tags).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const op = q.op === 'or' ? 'or' : 'and';

  if (tags.length) {
    const tagIds = [];
    for (const name of tags) {
      const id = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)?.id;
      if (id) tagIds.push(id);
    }
    if (tagIds.length) {
      if (op === 'and') {
        // 拥有全部标签
        where.push(`(SELECT COUNT(DISTINCT tag_id) FROM photo_tags pt
                     WHERE pt.photo_id = p.id AND pt.tag_id IN (${tagIds.map(() => '?').join(',')})) = ${tagIds.length}`);
        params.push(...tagIds);
      } else {
        where.push(`EXISTS (SELECT 1 FROM photo_tags pt
                     WHERE pt.photo_id = p.id AND pt.tag_id IN (${tagIds.map(() => '?').join(',')}))`);
        params.push(...tagIds);
      }
    }
  }

  if (q.from) { where.push('p.taken_at >= ?'); params.push(q.from); }
  if (q.to) { where.push('p.taken_at <= ?'); params.push(q.to + 'T23:59:59.999Z'); }

  // 自由文本搜索：标签名包含关键字（不区分大小写）
  if (q.q) {
    where.push(`EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                 WHERE pt.photo_id = p.id AND t.name LIKE ?)`);
    params.push(`%${q.q}%`);
  }

  const smart = q.smart;
  const dayMs = 24 * 3600 * 1000;
  if (smart === 'inbox') {
    where.push('p.imported_at >= ?');
    params.push(new Date(Date.now() - dayMs).toISOString());
  } else if (smart === 'unclassified') {
    // 未分类 = 还没跑过 CLIP/人工标签（仅系统规则标不算已分类）
    where.push(`NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source IN ('clip','manual'))`);
  } else if (smart === 'review') {
    // 用每组有效阈值判定（见 reviewClause），而不是全局阈值，避免确认标签被误判进待确认
    where.push(`(${reviewClause()})`);
  } else if (smart === 'dup') {
    where.push(`p.phash IS NOT NULL AND p.phash IN (
                  SELECT phash FROM photos WHERE phash IS NOT NULL GROUP BY phash HAVING COUNT(*) > 1)`);
  } else if (smart === 'doc') {
    where.push(`EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                  WHERE pt.photo_id = p.id AND t.group_name = '文档')`);
  }

  return { where, params };
}

// ---- 路由 ----
export async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // 静态：缩略图 / 原图 / web 前端
    if (p.startsWith('/v1/thumbs/')) {
      const id = p.split('/').pop();
      const row = getDb().prepare('SELECT thumb_path FROM photos WHERE id = ?').get(id);
      serveFile(res, row?.thumb_path ? path.join(THUMBS_DIR, row.thumb_path) : null, 'image/jpeg');
      return;
    }
    if (p.startsWith('/v1/files/')) {
      const id = p.split('/').pop();
      const row = getDb().prepare('SELECT path FROM photos WHERE id = ?').get(id);
      serveFile(res, row?.path || null, null);
      return;
    }

    // API
    if (req.method === 'POST' && p === '/v1/browse') {
      const dir = await pickFolder();
      json(res, 200, { dir });
      return;
    }

    if (req.method === 'POST' && p === '/v1/import') {
      const body = await readBody(req);
      const dir = body.dir || INBOX_DIR;
      try {
        const result = await runImport(dir);
        json(res, 200, result);
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
      return;
    }

    if (req.method === 'POST' && p === '/v1/import-files') {
      const ct = req.headers['content-type'] || '';
      if (!ct.includes('multipart/form-data')) { json(res, 400, { error: 'expect multipart/form-data' }); return; }
      try {
        const raw = await readRaw(req);
        const parts = parseMultipart(raw, ct).filter((x) => x.filename);
        if (!parts.length) { json(res, 400, { error: 'no files' }); return; }
        const dir = path.join(INBOX_DIR, 'uploads');
        fs.mkdirSync(dir, { recursive: true });
        for (const part of parts) {
          const safe = (part.filename || 'file').replace(/[/\\?%*:|"<>]/g, '_');
          const dest = path.join(dir, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safe}`);
          fs.writeFileSync(dest, part.buffer);
        }
        const result = await runImport(dir);
        json(res, 200, result);
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
      return;
    }

    if (req.method === 'POST' && p === '/v1/tag') {
      const body = await readBody(req);
      const limit = Math.min(parseInt(body.limit || '200'), 1000);
      const db = getDb();
      // scope=all = 全部重新分：清掉已有 clip 标签再跑（人工/规则标签保留）
      if (body.scope === 'all') {
        db.prepare(`DELETE FROM photo_tags WHERE source = 'clip'`).run();
      }
      // 已有打标任务在跑 → 直接返回进行中的 jobId，避免并发推理
      if (currentTagJob != null) {
        const j = getJob(currentTagJob);
        if (j && (j.status === 'queued' || j.status === 'running')) {
          json(res, 200, { jobId: currentTagJob, status: j.status });
          return;
        }
        currentTagJob = null;
      }
      const job = db.prepare("INSERT INTO jobs (type, status, total, done) VALUES ('tag', 'queued', 0, 0)").run();
      const jobId = Number(job.lastInsertRowid);
      currentTagJob = jobId;
      // 后台跑，不阻塞响应；模型未下载/网络失败时 job 置为 error
      Promise.resolve().then(async () => {
        try {
          const { tagAll } = await import('./clip.js');
          await tagAll(limit, jobId);
        } catch (e) {
          updateJob(jobId, { status: 'error', error: String(e?.message ?? e) });
        } finally {
          if (currentTagJob === jobId) currentTagJob = null;
        }
      });
      json(res, 200, { jobId, status: 'queued' });
      return;
    }

    if (req.method === 'GET' && /^\/v1\/jobs\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      const job = getJob(id);
      if (!job) { json(res, 404, { error: 'not found' }); return; }
      let stats = null;
      try { stats = job.stats ? JSON.parse(job.stats) : null; } catch { stats = null; }
      json(res, 200, {
        id: job.id, type: job.type, status: job.status,
        total: job.total, done: job.done, error: job.error, stats,
      });
      return;
    }

    if (req.method === 'GET' && p === '/v1/photos') {
      const db = getDb();
      const sp = url.searchParams;
      const filter = {
        tags: sp.get('tags'), op: sp.get('op'), from: sp.get('from'),
        to: sp.get('to'), smart: sp.get('smart'), q: sp.get('q'),
      };
      const { where, params } = buildFilter(filter);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '200'), 2000);
      const offset = parseInt(url.searchParams.get('offset') || '0');

      const totalRow = db.prepare(`SELECT COUNT(*) c FROM photos p WHERE ${where.join(' AND ')}`).get(...params);
      const rows = db.prepare(`
        SELECT p.id, p.width, p.height, p.taken_at, p.imported_at, p.source_dir, p.thumb_path, p.status
        FROM photos p WHERE ${where.join(' AND ')}
        ORDER BY p.taken_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);

      // 每张图的标签
      const ids = rows.map((r) => r.id);
      const tagsByPhoto = {};
      if (ids.length) {
        const tagRows = db.prepare(`
          SELECT pt.photo_id, t.name, t.kind, pt.source, pt.confidence, pt.rejected
          FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.photo_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
        for (const tr of tagRows) {
          (tagsByPhoto[tr.photo_id] ||= []).push({
            name: tr.name, kind: tr.kind, source: tr.source,
            confidence: tr.confidence, rejected: tr.rejected,
          });
        }
      }
      const photos = rows.map((r) => ({ ...r, tags: tagsByPhoto[r.id] || [] }));
      json(res, 200, { total: totalRow.c, items: photos, limit, offset });
      return;
    }

    if (req.method === 'GET' && /^\/v1\/photos\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      const db = getDb();
      const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(id);
      if (!photo) { json(res, 404, { error: 'not found' }); return; }
      const tags = db.prepare(`
        SELECT t.name, t.kind, t.group_name, pt.source, pt.confidence, pt.rejected
        FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.photo_id = ?`).all(id);
      // 相近重复
      let dupes = [];
      if (photo.phash) {
        const others = db.prepare('SELECT id, phash FROM photos WHERE phash IS NOT NULL AND id != ?').all(id);
        dupes = others.filter((o) => hamming(photo.phash, o.phash) <= 8).map((o) => o.id);
      }
      json(res, 200, { ...photo, tags, dupes });
      return;
    }

    if (req.method === 'PUT' && /^\/v1\/photos\/\d+\/tags$/.test(p)) {
      const id = Number(p.split('/')[3]);
      const body = await readBody(req);
      const db = getDb();
      const photo = db.prepare('SELECT id FROM photos WHERE id = ?').get(id);
      if (!photo) { json(res, 404, { error: 'not found' }); return; }

      const toAdd = body.add || [];
      const toRemove = body.remove || [];
      for (const name of toAdd) {
        const tagId = ensureTag(name, body.group || '用途', 'manual');
        upsertTag(id, tagId, 'manual', 1.0);
      }
      for (const name of toRemove) {
        const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)?.id;
        if (tagId) {
          const row = db.prepare('SELECT source FROM photo_tags WHERE photo_id = ? AND tag_id = ?').get(id, tagId);
          if (row && row.source !== 'manual') rejectTag(id, tagId, 'remove');
          else deletePhotoTag(id, tagId, 'remove');
        }
      }
      json(res, 200, { ok: true });
      return;
    }

    // 人工确认（待确认审阅流）：keep = 认可的标签升级为 manual（保留原置信度，退出待确认）；
    // remove = 驳回（记 feedback，自动抬高该标签阈值）
    if (req.method === 'POST' && /^\/v1\/photos\/\d+\/confirm$/.test(p)) {
      const id = Number(p.split('/')[3]);
      const body = await readBody(req);
      const db = getDb();
      if (!db.prepare('SELECT id FROM photos WHERE id = ?').get(id)) { json(res, 404, { error: 'not found' }); return; }
      const keep = Array.isArray(body.keep) ? body.keep.map(String) : [];
      const remove = Array.isArray(body.remove) ? body.remove.map(String) : [];
      for (const name of remove) {
        const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)?.id;
        if (!tagId) continue;
        const row = db.prepare('SELECT source FROM photo_tags WHERE photo_id = ? AND tag_id = ?').get(id, tagId);
        if (row && row.source === 'manual') deletePhotoTag(id, tagId, 'remove');
        else rejectTag(id, tagId, 'remove');
      }
      for (const name of keep) {
        const tagId = db.prepare('SELECT id FROM tags WHERE name = ?').get(name)?.id;
        if (!tagId) continue;
        db.prepare(`
          INSERT INTO photo_tags (photo_id, tag_id, source, confidence, rejected)
          VALUES (?, ?, 'manual', NULL, 0)
          ON CONFLICT(photo_id, tag_id) DO UPDATE SET source = 'manual', rejected = 0
        `).run(id, tagId);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && /^\/v1\/photos\/\d+\/classify$/.test(p)) {
      const id = Number(p.split('/')[3]);
      try {
        const { reclassifyPhoto } = await import('./clip.js');
        const r = await reclassifyPhoto(id);
        // top：模型对这张图的 top5 候选分数（含未过阈值的），便于界面解释「为什么没打上标」
        json(res, 200, { ok: true, tagged: r.tagged, review: r.review, top: r.top });
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
      return;
    }

    // 单图 AI 增强（云端 VLM）重新分类
    if (req.method === 'POST' && /^\/v1\/photos\/\d+\/classify-vlm$/.test(p)) {
      const id = Number(p.split('/')[3]);
      try {
        const vlm = await import('./vlm.js');
        if (!vlm.aiReady()) { json(res, 400, { error: 'AI 增强未启用或未配置 API Key（设置 → AI 增强）' }); return; }
        const n = await vlm.tagPhotoVlm(id);
        json(res, 200, { ok: true, tagged: n });
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
      return;
    }

    // 批量 AI 增强：scope=review（待确认相册，默认）或 ids
    if (req.method === 'POST' && p === '/v1/tag-vlm') {
      const body = await readBody(req);
      try {
        const vlm = await import('./vlm.js');
        if (!vlm.aiReady()) { json(res, 400, { error: 'AI 增强未启用或未配置 API Key（设置 → AI 增强）' }); return; }
        if (currentVlmJob != null) {
          const j = getJob(currentVlmJob);
          if (j && (j.status === 'queued' || j.status === 'running')) {
            json(res, 200, { jobId: currentVlmJob, status: j.status });
            return;
          }
          currentVlmJob = null;
        }
        const job = getDb().prepare("INSERT INTO jobs (type, status, total, done) VALUES ('tag-vlm', 'queued', 0, 0)").run();
        const jobId = Number(job.lastInsertRowid);
        currentVlmJob = jobId;
        Promise.resolve().then(async () => {
          try {
            await vlm.tagVlmAll({ scope: body.scope || 'review', ids: body.ids, limit: Math.min(parseInt(body.limit || '100'), 500) }, jobId);
          } catch (e) {
            updateJob(jobId, { status: 'error', error: String(e?.message ?? e) });
          } finally {
            if (currentVlmJob === jobId) currentVlmJob = null;
          }
        });
        json(res, 200, { jobId, status: 'queued' });
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
      return;
    }

    // 单图模型分数（按需推理，供灯箱「模型怎么看」调试视图）
    if (req.method === 'GET' && /^\/v1\/photos\/\d+\/scores$/.test(p)) {
      const id = Number(p.split('/')[3]);
      const photo = getDb().prepare('SELECT id, thumb_path FROM photos WHERE id = ?').get(id);
      if (!photo?.thumb_path) { json(res, 404, { error: 'not found' }); return; }
      try {
        const { scorePhoto } = await import('./clip.js');
        const r = await scorePhoto(path.join(THUMBS_DIR, photo.thumb_path));
        json(res, 200, { top: r.top, tags: r.tags, review: r.review });
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
      return;
    }

    // 阈值调整预览：基于已有 clip 标签估算某阈值下会保留多少（需重跑打标才完全生效）
    if (req.method === 'GET' && p === '/v1/tag-preview') {
      const db = getDb();
      const t = Number(url.searchParams.get('threshold'));
      const threshold = Number.isFinite(t) ? t : getThreshold();
      const keepTags = db.prepare(`SELECT COUNT(*) c FROM photo_tags WHERE source = 'clip' AND confidence >= ?`).get(threshold).c;
      const keepPhotos = db.prepare(`SELECT COUNT(DISTINCT photo_id) c FROM photo_tags WHERE source = 'clip' AND confidence >= ?`).get(threshold).c;
      const taggedPhotos = db.prepare(`SELECT COUNT(DISTINCT photo_id) c FROM photo_tags WHERE source = 'clip'`).get().c;
      json(res, 200, { threshold, keepTags, keepPhotos, taggedPhotos });
      return;
    }

    // 重置为未分类：清空该图全部标签（clip/manual/rule）及反馈，保留在图库中
    if (req.method === 'POST' && /^\/v1\/photos\/\d+\/reset$/.test(p)) {
      const id = Number(p.split('/')[3]);
      const db = getDb();
      if (!db.prepare('SELECT id FROM photos WHERE id = ?').get(id)) {
        json(res, 404, { error: 'not found' }); return;
      }
      db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(id);
      db.prepare('DELETE FROM feedback WHERE photo_id = ?').run(id);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'DELETE' && /^\/v1\/photos\/\d+$/.test(p)) {
      const id = Number(p.split('/').pop());
      const db = getDb();
      const photo = db.prepare('SELECT thumb_path FROM photos WHERE id = ?').get(id);
      if (!photo) { json(res, 404, { error: 'not found' }); return; }
      // 只删索引 + 缩略图，不碰原图文件（原图是用户自己的，不搬家）
      try { if (photo.thumb_path) fs.unlinkSync(path.join(THUMBS_DIR, photo.thumb_path)); } catch {}
      db.prepare('DELETE FROM photo_tags WHERE photo_id = ?').run(id);
      db.prepare('DELETE FROM feedback WHERE photo_id = ?').run(id);
      db.prepare('DELETE FROM photos WHERE id = ?').run(id);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && p === '/v1/settings') {
      const vocab = loadTags();
      json(res, 200, { threshold: vocab.threshold ?? 0.22 });
      return;
    }

    // 词表组开关：关闭的组模型不再自动打标
    if (req.method === 'PUT' && p === '/v1/vocab-group') {
      const body = await readBody(req);
      const name = String(body.name || '');
      const file = path.join(PROJECT_ROOT, 'config', 'tags.json');
      const vocab = JSON.parse(fs.readFileSync(file, 'utf8'));
      const g = (vocab.groups || []).find((x) => x.name === name);
      if (!g) { json(res, 404, { error: 'group not found' }); return; }
      if (body.disabled != null) g.disabled = !!body.disabled;
      fs.writeFileSync(file, JSON.stringify(vocab, null, 2) + '\n');
      json(res, 200, { ok: true, name: g.name, disabled: !!g.disabled });
      return;
    }

    // AI 增强（云端 VLM）设置：Key 只写本地 settings.json，返回时永远掩码
    if (req.method === 'GET' && p === '/v1/ai-settings') {
      const c = (await import('./vlm.js')).aiConfig();
      json(res, 200, {
        provider: c.provider,
        baseUrl: c.baseUrl,
        model: c.model,
        enabled: c.enabled,
        allowPrivateGroups: c.allowPrivateGroups,
        hasKey: !!c.apiKey,
        keyMasked: c.apiKey ? c.apiKey.slice(0, 4) + '****' + c.apiKey.slice(-4) : '',
      });
      return;
    }

    if (req.method === 'PUT' && p === '/v1/ai-settings') {
      const body = await readBody(req);
      const all = loadAppSettings();
      const ai = all.ai || {};
      if (body.provider != null) ai.provider = body.provider === 'openai' ? 'openai' : 'dashscope';
      if (body.baseUrl != null) ai.baseUrl = String(body.baseUrl);
      if (body.model != null) ai.model = String(body.model);
      if (body.enabled != null) ai.enabled = !!body.enabled;
      if (body.allowPrivateGroups != null) ai.allowPrivateGroups = !!body.allowPrivateGroups;
      // apiKey 传空串/缺省 = 保留旧 Key；传非空 = 覆盖
      if (typeof body.apiKey === 'string' && body.apiKey.trim()) ai.apiKey = body.apiKey.trim();
      all.ai = ai;
      saveAppSettings(all);
      json(res, 200, { ok: true, hasKey: !!ai.apiKey });
      return;
    }

    // 连通性测试（发一条最小请求验证 Key/网络）
    if (req.method === 'POST' && p === '/v1/ai-test') {
      try {
        const vlm = await import('./vlm.js');
        json(res, 200, await vlm.testConnection());
      } catch (e) {
        json(res, 200, { ok: false, error: String(e?.message ?? e) });
      }
      return;
    }

    if (req.method === 'PUT' && p === '/v1/settings') {
      const body = await readBody(req);
      const file = path.join(PROJECT_ROOT, 'config', 'tags.json');
      const vocab = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (body.threshold != null) vocab.threshold = Number(body.threshold);
      fs.writeFileSync(file, JSON.stringify(vocab, null, 2));
      json(res, 200, { ok: true, threshold: vocab.threshold });
      return;
    }

    if (req.method === 'GET' && p === '/v1/tags') {
      const db = getDb();
      const vocab = loadTags();
      const counts = db.prepare(`
        SELECT t.name, COUNT(pt.photo_id) c FROM tags t
        LEFT JOIN photo_tags pt ON pt.tag_id = t.id
        GROUP BY t.id`).all();
      const countMap = Object.fromEntries(counts.map((r) => [r.name, r.c]));
      // 动态来源标签（系统，来自目录名，不在词表里）
      const sourceTags = db.prepare(`
        SELECT t.name, COUNT(pt.photo_id) c FROM tags t
        JOIN photo_tags pt ON pt.tag_id = t.id
        WHERE t.group_name = '来源' GROUP BY t.id`).all();
      // 前端约定 vocab 为分组数组（每个含 name/kind/tags），故返回 vocab.groups
      json(res, 200, { vocab: vocab.groups || [], sourceTags, countMap });
      return;
    }

    // 新增词表标签
    if (req.method === 'POST' && p === '/v1/tags') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) { json(res, 400, { error: 'name required' }); return; }
      const groupName = String(body.group || '用途');
      const kind = String(body.kind || 'manual');
      const id = ensureTag(name, groupName, kind);
      json(res, 200, { ok: true, id });
      return;
    }

    // 删除词表标签（连带移除其标签关联）
    if (req.method === 'DELETE' && /^\/v1\/tags\/(.+)$/.test(p)) {
      const name = decodeURIComponent(p.split('/')[3]);
      const db = getDb();
      const tag = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
      if (!tag) { json(res, 404, { error: 'not found' }); return; }
      db.prepare('DELETE FROM photo_tags WHERE tag_id = ?').run(tag.id);
      db.prepare('DELETE FROM feedback WHERE tag_id = ?').run(tag.id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(tag.id);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === 'GET' && p === '/v1/info') {
      const modelDir = path.join(DATA_DIR, 'models', 'Xenova', 'clip-vit-base-patch32', 'onnx');
      const modelReady = fs.existsSync(modelDir);
      json(res, 200, {
        inboxDir: INBOX_DIR,
        tagsFile: path.join(PROJECT_ROOT, 'config', 'tags.json'),
        modelReady,
        model: 'Xenova/clip-vit-base-patch32',
        version: '0.1.0',
      });
      return;
    }

    if (req.method === 'GET' && p === '/v1/stats') {
      const db = getDb();
      const dayMs = 24 * 3600 * 1000;
      const dayAgo = new Date(Date.now() - dayMs).toISOString();
      const total = db.prepare("SELECT COUNT(*) c FROM photos WHERE status != 'failed'").get().c;
      const pending = db.prepare("SELECT COUNT(*) c FROM photos WHERE status = 'pending'").get().c;
      const inbox = db.prepare('SELECT COUNT(*) c FROM photos WHERE imported_at >= ?').get(dayAgo).c;
      const unclassified = db.prepare(`
        SELECT COUNT(*) c FROM photos p
        WHERE NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source IN ('clip','manual'))`).get().c;
      const dup = db.prepare(`
        SELECT COUNT(*) c FROM photos WHERE phash IS NOT NULL AND phash IN
        (SELECT phash FROM photos WHERE phash IS NOT NULL GROUP BY phash HAVING COUNT(*) > 1)`).get().c;
      const review = db.prepare(`
        SELECT COUNT(*) c FROM photos p
        WHERE ${reviewClause()}`).get().c;
      const doc = db.prepare(`
        SELECT COUNT(*) c FROM photos p WHERE EXISTS (
          SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.photo_id = p.id AND t.group_name = '文档')`).get().c;
      json(res, 200, { total, pending, inbox, unclassified, dup, review, doc });
      return;
    }

    if (req.method === 'POST' && p === '/v1/export') {
      const body = await readBody(req);
      const db = getDb();
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : null;
      let where, params;
      if (ids && ids.length) {
        where = [`p.status != 'failed'`, `p.id IN (${ids.map(() => '?').join(',')})`];
        params = ids;
      } else {
        ({ where, params } = buildFilter(body));
      }
      const rows = db.prepare(`SELECT id, path FROM photos p WHERE ${where.join(' AND ')}`).all(...params);
      const target = body.target;
      if (!target) { json(res, 400, { error: 'target required' }); return; }
      fs.mkdirSync(target, { recursive: true });
      let copied = 0;
      for (const r of rows) {
        const name = path.basename(r.path);
        const dest = path.join(target, name);
        let i = 1;
        let finalDest = dest;
        while (fs.existsSync(finalDest)) { finalDest = path.join(target, `${path.parse(name).name}_${i++}${path.extname(name)}`); }
        try { fs.copyFileSync(r.path, finalDest); copied++; } catch { /* skip */ }
      }
      json(res, 200, { copied, total: rows.length, target });
      return;
    }

    // 前端静态（优先 web/dist）
    let filePath = path.join(WEB_DIST, p === '/' ? 'index.html' : p.slice(1));
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }[ext];
      serveFile(res, filePath, mime);
      return;
    }
    if (p === '/' || p === '') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><h1>AI Image Tagger</h1><p>后端已运行。前端请先 <code>npm run build:web</code> 后访问。</p>');
      return;
    }
    json(res, 404, { error: 'not found', path: p });
  } catch (e) {
    json(res, 500, { error: String(e?.message ?? e) });
  }
}

export function startServer(port = PORT) {
  syncVocab();
  // 复位上次崩溃遗留的未完成打标任务，避免界面一直显示“进行中”
  try {
    const d = getDb();
    d.prepare("UPDATE jobs SET status = 'interrupted' WHERE status IN ('queued', 'running')").run();
  } catch {}
  const server = http.createServer((req, res) => { handle(req, res); });
  server.listen(port, HOST, () => {
    console.log(`[tagger] http://${HOST}:${server.address().port}`);
  });
  return server;
}
