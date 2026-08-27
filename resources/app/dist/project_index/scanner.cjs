'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'target',
  'dist/node_modules',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.idea',
  'temp',
  'tmp',
  'cache',
  '$RECYCLE.BIN',
  'System Volume Information',
  'AppData/Local/Temp',
  'AppData/Local/Microsoft/Windows/INetCache',
]);

const DEFAULT_IGNORE_PATTERNS = [
  /\.pyc$/i,
  /\.pyo$/i,
  /\.pyd\.tmp$/i,
  /\.tmp$/i,
  /\.log$/i,
  /\.bak$/i,
  /\.bak_[a-zA-Z0-9_]+$/i,
  /~.*/,
  /thumbs\.db$/i,
  /desktop\.ini$/i,
];

/**
 * High-Speed Recursive Filesystem Scanner for Multi-Root Project Indexing
 */
class ProjectScanner {
  /**
   * @param {Object} options
   * @param {Set<string>} [options.ignoreDirs]
   * @param {Array<RegExp|string>} [options.ignorePatterns]
   * @param {number} [options.maxDepth]
   */
  constructor(options = {}) {
    this.ignoreDirs = options.ignoreDirs || new Set(DEFAULT_IGNORE_DIRS);
    this.ignorePatterns = options.ignorePatterns || DEFAULT_IGNORE_PATTERNS;
    this.maxDepth = options.maxDepth || 32;

    // Extend from process.env if specified
    if (process.env.INDEX_IGNORE_DIRS) {
      process.env.INDEX_IGNORE_DIRS.split(',').map(s => s.trim()).filter(Boolean).forEach(d => this.ignoreDirs.add(d));
    }
    if (process.env.INDEX_IGNORE_PATTERNS) {
      process.env.INDEX_IGNORE_PATTERNS.split(',').map(s => s.trim()).filter(Boolean).forEach(p => {
        try { this.ignorePatterns.push(new RegExp(p, 'i')); } catch {}
      });
    }
  }

  isIgnoredDir(dirName, relPath) {
    if (this.ignoreDirs.has(dirName)) return true;
    const normRel = relPath.replace(/\\/g, '/');
    // Guard against whole drive roots
    if (/^[a-zA-Z]:[\\/]?$/.test(relPath)) return false;
    for (const d of this.ignoreDirs) {
      if (normRel === d || normRel.endsWith('/' + d) || normRel.includes('/' + d + '/')) {
        return true;
      }
    }
    return false;
  }

  isIgnoredFile(fileName) {
    for (const pat of this.ignorePatterns) {
      if (typeof pat === 'string') {
        if (fileName.endsWith(pat) || fileName === pat) return true;
      } else if (pat instanceof RegExp) {
        if (pat.test(fileName)) return true;
      }
    }
    return false;
  }

  /**
   * Scan a root directory asynchronously without blocking the event loop
   * @param {Object} root { id, path, name }
   * @param {Object} [callbacks] { onBatch, onProgress }
   * @returns {Promise<{ files: Array, directories: Array, stats: Object }>}
   */
  async scanRoot(root, callbacks = {}) {
    const rootPath = path.normalize(root.path);
    const rootId = root.id;

    // Guard: Disallow scanning root of drives directly unless verified
    if (/^[a-zA-Z]:\\?$/.test(rootPath)) {
      throw new Error(`Refusing to recursively index root drive '${rootPath}' directly. Configure specific folders.`);
    }

    if (!fs.existsSync(rootPath)) {
      console.warn(`[Scanner] Root path does not exist: ${rootPath}`);
      return { files: [], directories: [], stats: { files: 0, folders: 0, timeMs: 0 } };
    }

    const startTime = Date.now();
    const collectedFiles = [];
    const collectedDirs = [];
    let scannedItems = 0;
    const batchSize = 500;

    const queue = [{ dir: rootPath, rel: '', depth: 0 }];

    while (queue.length > 0) {
      const { dir, rel, depth } = queue.shift();
      if (depth > this.maxDepth) continue;

      let entries;
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (err) {
        // Permission denied or transient access issue
        continue;
      }

      let dirFileCount = 0;

      for (const entry of entries) {
        scannedItems++;
        const itemName = entry.name;
        const itemPath = path.join(dir, itemName);
        const itemRel = rel ? path.join(rel, itemName) : itemName;

        if (entry.isDirectory()) {
          if (this.isIgnoredDir(itemName, itemRel)) {
            continue;
          }

          const dirRecord = {
            root_id: rootId,
            path: itemPath,
            relative_path: itemRel,
            parent_dir: dir,
            name: itemName,
            file_count: 0
          };

          collectedDirs.push(dirRecord);
          queue.push({ dir: itemPath, rel: itemRel, depth: depth + 1 });
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          if (this.isIgnoredFile(itemName)) {
            continue;
          }

          dirFileCount++;
          let stat;
          try {
            stat = await fs.promises.stat(itemPath);
          } catch {
            continue;
          }

          const ext = path.extname(itemName).toLowerCase();
          const fileRecord = {
            root_id: rootId,
            path: itemPath,
            relative_path: itemRel,
            parent_dir: dir,
            name: itemName,
            extension: ext,
            is_directory: 0,
            size: stat.size,
            modified_time: Math.floor(stat.mtimeMs),
            created_time: Math.floor(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs),
            content_hash: null
          };

          collectedFiles.push(fileRecord);

          if (callbacks.onBatch && collectedFiles.length % batchSize === 0) {
            await callbacks.onBatch(collectedFiles.slice(-batchSize));
          }
        }
      }

      if (scannedItems % 1000 === 0) {
        if (callbacks.onProgress) {
          callbacks.onProgress({
            scanned: scannedItems,
            files: collectedFiles.length,
            folders: collectedDirs.length,
            currentDir: rel || root.name
          });
        }
        // Yield to event loop to keep server and UI completely responsive
        await new Promise(r => setImmediate(r));
      }
    }

    const elapsed = Date.now() - startTime;
    return {
      files: collectedFiles,
      directories: collectedDirs,
      stats: {
        scanned: scannedItems,
        files: collectedFiles.length,
        folders: collectedDirs.length,
        timeMs: elapsed
      }
    };
  }

  /**
   * Scan single file metadata
   */
  async scanFile(filePath, root) {
    const normalized = path.normalize(filePath);
    try {
      const stat = await fs.promises.stat(normalized);
      if (stat.isDirectory()) return null;
      const name = path.basename(normalized);
      if (this.isIgnoredFile(name)) return null;

      const rel = root ? path.relative(root.path, normalized) : name;
      return {
        root_id: root ? root.id : 1,
        path: normalized,
        relative_path: rel,
        parent_dir: path.dirname(normalized),
        name,
        extension: path.extname(name).toLowerCase(),
        is_directory: 0,
        size: stat.size,
        modified_time: Math.floor(stat.mtimeMs),
        created_time: Math.floor(stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs),
        content_hash: null
      };
    } catch {
      return null;
    }
  }
}

module.exports = { ProjectScanner, DEFAULT_IGNORE_DIRS, DEFAULT_IGNORE_PATTERNS };
