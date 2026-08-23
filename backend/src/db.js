import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, loadTags } from './config.js';

let db = null;

export function getDb() {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  migrate(db);
  return db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      path        TEXT NOT NULL UNIQUE,
      file_hash   TEXT NOT NULL,
      phash       TEXT,
      bytes       INTEGER,
      width       INTEGER,
      height      INTEGER,
      taken_at    TEXT,
      imported_at TEXT NOT NULL,
      camera      TEXT,
      gps_lat     REAL,
      gps_lon     REAL,
      source_dir  TEXT,
      thumb_path  TEXT,
      status      TEXT NOT NULL DEFAULT 'pending'  -- pending / ready / failed
    );

    CREATE TABLE IF NOT EXISTS tags (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      group_name TEXT,
      kind       TEXT NOT NULL            -- system / auto / manual
    );

    CREATE TABLE IF NOT EXISTS photo_tags (
      photo_id    INTEGER NOT NULL,
      tag_id      INTEGER NOT NULL,
      source      TEXT NOT NULL,          -- rule / clip / vlm / manual
      confidence  REAL,
      rejected    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (photo_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id   INTEGER NOT NULL,
      tag_id     INTEGER NOT NULL,
      action     TEXT NOT NULL,           -- add / remove
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      type   TEXT NOT NULL,
      status TEXT NOT NULL,
      total  INTEGER DEFAULT 0,
      done   INTEGER DEFAULT 0,
      error  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_photo_tags_tag  ON photo_tags(tag_id);
    CREATE INDEX IF NOT EXISTS idx_photo_tags_photo ON photo_tags(photo_id);
    CREATE INDEX IF NOT EXISTS idx_photos_hash      ON photos(file_hash);
  `);
}

// 词表标签 -> 库里 tags 表（幂等）
export function syncVocab() {
  const d = getDb();
  const vocab = loadTags();
  const ins = d.prepare('INSERT OR IGNORE INTO tags (name, group_name, kind) VALUES (?, ?, ?)');
  for (const g of vocab.groups) {
    for (const name of g.tags) {
      ins.run(name, g.name, g.kind);
    }
  }
}

export function getTagId(name) {
  const row = getDb().prepare('SELECT id FROM tags WHERE name = ?').get(name);
  return row ? row.id : null;
}

export function ensureTag(name, groupName, kind) {
  const d = getDb();
  d.prepare('INSERT OR IGNORE INTO tags (name, group_name, kind) VALUES (?, ?, ?)').run(name, groupName, kind);
  return getTagId(name);
}

export function upsertTag(photoId, tagId, source, confidence = null) {
  const d = getDb();
  d.prepare(`
    INSERT INTO photo_tags (photo_id, tag_id, source, confidence, rejected)
    VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(photo_id, tag_id) DO UPDATE SET
      source = excluded.source,
      confidence = excluded.confidence
  `).run(photoId, tagId, source, confidence);
}

export function rejectTag(photoId, tagId, action = 'remove') {
  const d = getDb();
  d.prepare(`UPDATE photo_tags SET rejected = 1 WHERE photo_id = ? AND tag_id = ?`).run(photoId, tagId);
  d.prepare(`INSERT INTO feedback (photo_id, tag_id, action, created_at) VALUES (?, ?, ?, ?)`)
    .run(photoId, tagId, action, new Date().toISOString());
}

export function deletePhotoTag(photoId, tagId, action = 'remove') {
  const d = getDb();
  d.prepare(`DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?`).run(photoId, tagId);
  d.prepare(`INSERT INTO feedback (photo_id, tag_id, action, created_at) VALUES (?, ?, ?, ?)`)
    .run(photoId, tagId, action, new Date().toISOString());
}

// 每个标签被人手驳回的次数（用于微调打标阈值）
export function rejectCounts() {
  const rows = getDb().prepare(`
    SELECT t.name, COUNT(*) c FROM feedback f JOIN tags t ON t.id = f.tag_id
    WHERE f.action = 'remove' GROUP BY t.id`).all();
  return Object.fromEntries(rows.map((r) => [r.name, r.c]));
}
