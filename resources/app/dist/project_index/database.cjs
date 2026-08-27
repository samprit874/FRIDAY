'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

/**
 * SQLite Local Database Manager for FRIDAY Project & Multi-Root Indexer
 */
class IndexDatabase {
  /**
   * @param {string} dbPath Absolute path to the sqlite file
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.initSchema();
    this.prepareStatements();
  }

  initPragmas() {
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA temp_store = MEMORY;');
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS roots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        priority INTEGER DEFAULT 1,
        enabled INTEGER DEFAULT 1,
        last_scanned INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id INTEGER NOT NULL,
        path TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        parent_dir TEXT NOT NULL,
        name TEXT NOT NULL,
        extension TEXT NOT NULL,
        is_directory INTEGER DEFAULT 0,
        size INTEGER DEFAULT 0,
        modified_time INTEGER DEFAULT 0,
        created_time INTEGER DEFAULT 0,
        content_hash TEXT,
        FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        root_id INTEGER NOT NULL,
        path TEXT NOT NULL UNIQUE,
        relative_path TEXT NOT NULL,
        parent_dir TEXT NOT NULL,
        name TEXT NOT NULL,
        file_count INTEGER DEFAULT 0,
        FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id INTEGER NOT NULL,
        root_id INTEGER NOT NULL,
        symbol_name TEXT NOT NULL,
        symbol_type TEXT NOT NULL,
        line_number INTEGER NOT NULL,
        parent_symbol TEXT,
        signature TEXT,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
        FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
      CREATE INDEX IF NOT EXISTS idx_files_name_nocase ON files(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_files_rel ON files(relative_path);
      CREATE INDEX IF NOT EXISTS idx_files_ext ON files(extension);
      CREATE INDEX IF NOT EXISTS idx_files_root ON files(root_id);
      CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(modified_time);

      CREATE INDEX IF NOT EXISTS idx_dirs_name ON directories(name);
      CREATE INDEX IF NOT EXISTS idx_dirs_name_nocase ON directories(name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_dirs_path ON directories(path);
      CREATE INDEX IF NOT EXISTS idx_dirs_root ON directories(root_id);

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(symbol_name);
      CREATE INDEX IF NOT EXISTS idx_symbols_name_nocase ON symbols(symbol_name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
      CREATE INDEX IF NOT EXISTS idx_symbols_root ON symbols(root_id);
    `);
  }

  prepareStatements() {
    this.stmts = {
      // Roots
      getRoots: this.db.prepare('SELECT * FROM roots ORDER BY priority ASC, id ASC'),
      getRootById: this.db.prepare('SELECT * FROM roots WHERE id = ?'),
      getRootByPath: this.db.prepare('SELECT * FROM roots WHERE path = ?'),
      insertRoot: this.db.prepare(`
        INSERT INTO roots (name, path, priority, enabled, last_scanned)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          name = excluded.name,
          priority = excluded.priority,
          enabled = excluded.enabled
      `),
      updateRootScanTime: this.db.prepare('UPDATE roots SET last_scanned = ? WHERE id = ?'),
      deleteRoot: this.db.prepare('DELETE FROM roots WHERE id = ?'),

      // Files
      insertFile: this.db.prepare(`
        INSERT INTO files (root_id, path, relative_path, parent_dir, name, extension, is_directory, size, modified_time, created_time, content_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          root_id = excluded.root_id,
          relative_path = excluded.relative_path,
          parent_dir = excluded.parent_dir,
          name = excluded.name,
          extension = excluded.extension,
          is_directory = excluded.is_directory,
          size = excluded.size,
          modified_time = excluded.modified_time,
          created_time = excluded.created_time,
          content_hash = excluded.content_hash
      `),
      getFileByPath: this.db.prepare('SELECT * FROM files WHERE path = ?'),
      getFileById: this.db.prepare('SELECT * FROM files WHERE id = ?'),
      deleteFileByPath: this.db.prepare('DELETE FROM files WHERE path = ?'),
      deleteFilesByRoot: this.db.prepare('DELETE FROM files WHERE root_id = ?'),
      getFilesMtimeMap: this.db.prepare('SELECT path, modified_time, id FROM files WHERE root_id = ?'),

      // Directories
      insertDir: this.db.prepare(`
        INSERT INTO directories (root_id, path, relative_path, parent_dir, name, file_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          root_id = excluded.root_id,
          relative_path = excluded.relative_path,
          parent_dir = excluded.parent_dir,
          name = excluded.name,
          file_count = excluded.file_count
      `),
      getDirByPath: this.db.prepare('SELECT * FROM directories WHERE path = ?'),
      deleteDirByPath: this.db.prepare('DELETE FROM directories WHERE path = ?'),
      deleteDirsByRoot: this.db.prepare('DELETE FROM directories WHERE root_id = ?'),

      // Symbols
      insertSymbol: this.db.prepare(`
        INSERT INTO symbols (file_id, root_id, symbol_name, symbol_type, line_number, parent_symbol, signature)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
      deleteSymbolsByFile: this.db.prepare('DELETE FROM symbols WHERE file_id = ?'),
      deleteSymbolsByRoot: this.db.prepare('DELETE FROM symbols WHERE root_id = ?'),

      // Meta
      getMeta: this.db.prepare('SELECT value FROM meta WHERE key = ?'),
      setMeta: this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),

      // Counts
      countFiles: this.db.prepare('SELECT COUNT(*) AS count FROM files WHERE is_directory = 0'),
      countDirs: this.db.prepare('SELECT COUNT(*) AS count FROM directories'),
      countSymbols: this.db.prepare('SELECT COUNT(*) AS count FROM symbols'),
      countFilesByRoot: this.db.prepare('SELECT COUNT(*) AS count FROM files WHERE root_id = ? AND is_directory = 0'),
    };
  }

  // --- Roots Management ---

  getRoots() {
    return this.stmts.getRoots.all();
  }

  getRootById(id) {
    return this.stmts.getRootById.get(id);
  }

  getRootByPath(rootPath) {
    const normalized = path.normalize(rootPath);
    return this.stmts.getRootByPath.get(normalized);
  }

  addRoot(name, rootPath, priority = 1, enabled = 1) {
    const normalized = path.normalize(rootPath);
    this.stmts.insertRoot.run(name, normalized, priority, enabled ? 1 : 0, 0);
    return this.getRootByPath(normalized);
  }

  updateRootScanTime(rootId, timestamp = Date.now()) {
    this.stmts.updateRootScanTime.run(timestamp, rootId);
  }

  removeRoot(rootId) {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      this.stmts.deleteSymbolsByRoot.run(rootId);
      this.stmts.deleteFilesByRoot.run(rootId);
      this.stmts.deleteDirsByRoot.run(rootId);
      this.stmts.deleteRoot.run(rootId);
      this.db.exec('COMMIT;');
      return true;
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  // --- Files & Directories Batch Operations ---

  insertOrUpdateFile(file) {
    const res = this.stmts.insertFile.run(
      file.root_id,
      path.normalize(file.path),
      file.relative_path,
      file.parent_dir,
      file.name,
      file.extension || '',
      file.is_directory ? 1 : 0,
      file.size || 0,
      file.modified_time || 0,
      file.created_time || 0,
      file.content_hash || null
    );
    return res.lastInsertRowid;
  }

  batchInsertFiles(files) {
    if (!files || files.length === 0) return;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const file of files) {
        this.stmts.insertFile.run(
          file.root_id,
          path.normalize(file.path),
          file.relative_path,
          file.parent_dir,
          file.name,
          file.extension || '',
          file.is_directory ? 1 : 0,
          file.size || 0,
          file.modified_time || 0,
          file.created_time || 0,
          file.content_hash || null
        );
      }
      this.db.exec('COMMIT;');
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  batchInsertDirectories(dirs) {
    if (!dirs || dirs.length === 0) return;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      for (const dir of dirs) {
        this.stmts.insertDir.run(
          dir.root_id,
          path.normalize(dir.path),
          dir.relative_path,
          dir.parent_dir,
          dir.name,
          dir.file_count || 0
        );
      }
      this.db.exec('COMMIT;');
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  getFileByPath(filePath) {
    return this.stmts.getFileByPath.get(path.normalize(filePath));
  }

  deleteFileByPath(filePath) {
    const normalized = path.normalize(filePath);
    const existing = this.stmts.getFileByPath.get(normalized);
    if (existing) {
      this.stmts.deleteSymbolsByFile.run(existing.id);
      this.stmts.deleteFileByPath.run(normalized);
    }
  }

  deleteDirectoryByPath(dirPath) {
    const normalized = path.normalize(dirPath);
    this.stmts.deleteDirByPath.run(normalized);
  }

  getFilesMtimeMap(rootId) {
    const rows = this.stmts.getFilesMtimeMap.all(rootId);
    const map = new Map();
    for (const r of rows) {
      map.set(r.path, { id: r.id, mtime: r.modified_time });
    }
    return map;
  }

  // --- Symbols Operations ---

  insertSymbols(fileId, rootId, symbols) {
    if (!symbols || symbols.length === 0) return;
    this.db.exec('BEGIN TRANSACTION;');
    try {
      this.stmts.deleteSymbolsByFile.run(fileId);
      for (const sym of symbols) {
        this.stmts.insertSymbol.run(
          fileId,
          rootId,
          sym.name,
          sym.type || 'function',
          sym.line || 1,
          sym.parent || null,
          sym.signature || null
        );
      }
      this.db.exec('COMMIT;');
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  deleteSymbolsByFile(fileId) {
    this.stmts.deleteSymbolsByFile.run(fileId);
  }

  // --- Meta & Stats ---

  getMeta(key) {
    const row = this.stmts.getMeta.get(key);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.stmts.setMeta.run(key, String(value));
  }

  getStats() {
    const fileCount = this.stmts.countFiles.get()?.count || 0;
    const dirCount = this.stmts.countDirs.get()?.count || 0;
    const symbolCount = this.stmts.countSymbols.get()?.count || 0;
    const roots = this.getRoots();
    return {
      files: fileCount,
      folders: dirCount,
      symbols: symbolCount,
      roots: roots.map(r => ({
        id: r.id,
        name: r.name,
        path: r.path,
        priority: r.priority,
        enabled: Boolean(r.enabled),
        last_scanned: r.last_scanned,
        file_count: this.stmts.countFilesByRoot.get(r.id)?.count || 0
      }))
    };
  }

  clearRoot(rootId) {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      this.stmts.deleteSymbolsByRoot.run(rootId);
      this.stmts.deleteFilesByRoot.run(rootId);
      this.stmts.deleteDirsByRoot.run(rootId);
      this.db.exec('COMMIT;');
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  clearAll() {
    this.db.exec('BEGIN TRANSACTION;');
    try {
      this.db.exec('DELETE FROM symbols;');
      this.db.exec('DELETE FROM files;');
      this.db.exec('DELETE FROM directories;');
      this.db.exec('DELETE FROM meta;');
      this.db.exec('COMMIT;');
    } catch (e) {
      this.db.exec('ROLLBACK;');
      throw e;
    }
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

module.exports = { IndexDatabase };
