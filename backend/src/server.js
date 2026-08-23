import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { getDb, syncVocab, ensureTag, upsertTag, deletePhotoTag, rejectTag } from './db.js';
import { runImport } from './import.js';
import { INBOX_DIR, PROJECT_ROOT, THUMBS_DIR, DATA_DIR, loadTags } from './config.js';
import { hamming } from './hashing.js';

const WEB_DIST = process.env.TAGGER_WEB_DIST || path.join(PROJECT_ROOT, 'web', 'dist');

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });
}

function serveFile(res, filePath, contentType) {
  if (!filePath || !fs.existsSync(filePath)) {
    res.writeHead(404); res.end('not found'); return;
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'max-age=31536000, immutable',
  });
  fs.createReadStream(filePath).pipe(res);
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

  const smart = q.smart;
  const dayMs = 24 * 3600 * 1000;
  if (smart === 'inbox') {
    where.push('p.imported_at >= ?');
    params.push(new Date(Date.now() - dayMs).toISOString());
  } else if (smart === 'unclassified') {
    where.push('NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)');
  } else if (smart === 'review') {
    where.push(`EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.rejected = 0)
                AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source = 'manual')
                AND EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND (pt.confidence IS NULL OR pt.confidence < 0.22))`);
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
      const result = await runImport(dir);
      json(res, 200, result);
      return;
    }

    if (req.method === 'POST' && p === '/v1/tag') {
      const body = await readBody(req);
      const limit = Math.min(parseInt(body.limit || '200'), 1000);
      try {
        const { tagAll } = await import('./clip.js');
        const r = await tagAll(limit);
        json(res, 200, r);
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
      return;
    }

    if (req.method === 'GET' && p === '/v1/photos') {
      const db = getDb();
      const sp = url.searchParams;
      const filter = {
        tags: sp.get('tags'), op: sp.get('op'), from: sp.get('from'),
        to: sp.get('to'), smart: sp.get('smart'),
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

    if (req.method === 'POST' && /^\/v1\/photos\/\d+\/classify$/.test(p)) {
      const id = Number(p.split('/')[3]);
      try {
        const { reclassifyPhoto } = await import('./clip.js');
        const n = await reclassifyPhoto(id);
        json(res, 200, { ok: true, tagged: n });
      } catch (e) {
        json(res, 500, { error: String(e?.message ?? e) });
      }
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
      json(res, 200, { vocab, sourceTags, countMap });
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
        SELECT COUNT(*) c FROM photos p WHERE NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id)`).get().c;
      const dup = db.prepare(`
        SELECT COUNT(*) c FROM photos WHERE phash IS NOT NULL AND phash IN
        (SELECT phash FROM photos WHERE phash IS NOT NULL GROUP BY phash HAVING COUNT(*) > 1)`).get().c;
      const review = db.prepare(`
        SELECT COUNT(*) c FROM photos p
        WHERE EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.rejected = 0)
          AND NOT EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.source = 'manual')
          AND EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND (pt.confidence IS NULL OR pt.confidence < 0.22))`).get().c;
      const doc = db.prepare(`
        SELECT COUNT(*) c FROM photos p WHERE EXISTS (
          SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE pt.photo_id = p.id AND t.group_name = '文档')`).get().c;
      json(res, 200, { total, pending, inbox, unclassified, dup, review, doc });
      return;
    }

    if (req.method === 'POST' && p === '/v1/export') {
      const body = await readBody(req);
      const { where, params } = buildFilter(body);
      const db = getDb();
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

export function startServer() {
  syncVocab();
  const server = http.createServer((req, res) => { handle(req, res); });
  server.listen(47910, '127.0.0.1', () => {
    console.log('[tagger] http://127.0.0.1:47910');
  });
  return server;
}
