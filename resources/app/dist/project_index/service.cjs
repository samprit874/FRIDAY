'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');

const { IndexDatabase } = require('./database.cjs');
const { ProjectScanner } = require('./scanner.cjs');
const { SymbolIndexer } = require('./symbols.cjs');
const { IndexWatcher } = require('./watcher.cjs');
const { SearchEngine } = require('./search.cjs');

/**
 * FRIDAY Multi-Root High-Speed Project & Workspace Index Service
 */
class ProjectIndexService extends EventEmitter {
  /**
   * @param {Object} [options]
   * @param {string} [options.dataDir] Directory to store the sqlite database
   * @param {string} [options.projectRoot] Root path for FRIDAY project
   */
  constructor(options = {}) {
    super();
    this.dataDir = options.dataDir || process.env.FRIDAY_DATA_DIR || process.cwd();
    this.dbPath = path.join(this.dataDir, 'friday_project_index.sqlite');

    this.projectRoot = options.projectRoot || this.resolveProjectRoot();
    this.status = 'INITIALIZING';
    this.lastScanTime = 0;
    this.isIndexing = false;
    this.isClosed = false;

    // Subsystems
    this.db = new IndexDatabase(this.dbPath);
    this.scanner = new ProjectScanner();
    this.symbolIndexer = new SymbolIndexer();
    this.searchEngine = new SearchEngine(this.db);
    this.watcher = new IndexWatcher({
      ignoreDirs: this.scanner.ignoreDirs,
      onFileChange: (evt) => this.handleFileChangeEvent(evt),
      onDirChange: (evt) => this.handleDirChangeEvent(evt)
    });

    this.initDefaultRoots();
  }

  resolveProjectRoot() {
    if (process.env.FRIDAY_PROJECT_ROOT && fs.existsSync(process.env.FRIDAY_PROJECT_ROOT)) {
      return path.normalize(process.env.FRIDAY_PROJECT_ROOT);
    }
    if (process.env.FRIDAY_APP_ROOT && fs.existsSync(process.env.FRIDAY_APP_ROOT)) {
      const parent = path.resolve(process.env.FRIDAY_APP_ROOT, '..', '..');
      if (fs.existsSync(parent)) return parent;
    }
    // Check cwd and ancestor directories
    let current = path.resolve(__dirname, '..', '..', '..');
    if (fs.existsSync(path.join(current, 'FRIDAY.exe')) || fs.existsSync(path.join(current, 'resources'))) {
      return current;
    }
    return process.cwd();
  }

  initDefaultRoots() {
    const defaultRoots = [
      { name: 'FRIDAY Project', path: this.projectRoot, priority: 1, enabled: 1 },
      { name: 'Desktop', path: path.join(os.homedir(), 'Desktop'), priority: 2, enabled: 1 },
      { name: 'Documents', path: path.join(os.homedir(), 'Documents'), priority: 3, enabled: 1 },
      { name: 'Downloads', path: path.join(os.homedir(), 'Downloads'), priority: 4, enabled: 1 },
    ];

    for (const r of defaultRoots) {
      if (fs.existsSync(r.path)) {
        const existing = this.db.getRootByPath(r.path);
        if (!existing) {
          this.db.addRoot(r.name, r.path, r.priority, r.enabled);
        }
      }
    }
  }

  /**
   * Start the index service immediately with zero-blocking startup
   */
  start() {
    if (this.isClosed) return this;
    const stats = this.db.getStats();
    console.log(`[IndexService] Loaded index with ${stats.files} files, ${stats.folders} folders, ${stats.symbols} symbols across ${stats.roots.length} roots.`);
    this.status = stats.files > 0 ? 'READY' : 'NEEDS_INDEX';
    this.lastScanTime = parseInt(this.db.getMeta('last_scan_time') || '0', 10);

    // Start background watcher on existing roots
    const roots = this.db.getRoots();
    this.watcher.start(roots);

    // Schedule background reconciliation without blocking server boot
    setTimeout(() => {
      if (!this.isClosed) {
        this.reconcileAllRootsInBackground().catch((err) => {
          if (!this.isClosed) console.warn('[IndexService] Background reconcile error:', err.message);
        });
      }
    }, 800);

    return this;
  }

  /**
   * Background asynchronous reconciliation of all roots
   */
  async reconcileAllRootsInBackground() {
    if (this.isIndexing || this.isClosed) return;
    this.isIndexing = true;
    this.status = 'INDEXING';
    this.emit('status_change', { status: this.status });

    const roots = this.db.getRoots();
    console.log(`[IndexService] Background reconciliation starting for ${roots.length} roots...`);

    let totalIndexedFiles = 0;
    let totalIndexedSymbols = 0;

    for (const root of roots) {
      if (this.isClosed) break;
      if (!root.enabled || !fs.existsSync(root.path)) continue;

      try {
        const rootRes = await this.indexRoot(root, {
          onProgress: (prog) => {
            if (this.isClosed) return;
            this.emit('progress', {
              root: root.name,
              scanned: prog.scanned,
              files: prog.files,
              folders: prog.folders,
              currentDir: prog.currentDir
            });
          }
        });
        totalIndexedFiles += rootRes.files;
        totalIndexedSymbols += rootRes.symbols;
      } catch (err) {
        if (!this.isClosed) console.warn(`[IndexService] Error indexing root ${root.name}:`, err.message);
      }
    }

    if (this.isClosed) return;

    this.isIndexing = false;
    this.status = 'READY';
    this.lastScanTime = Date.now();
    this.db.setMeta('last_scan_time', String(this.lastScanTime));

    const finalStats = this.db.getStats();
    console.log(`[IndexService] Indexing complete: ${finalStats.files} files, ${finalStats.folders} folders, ${finalStats.symbols} symbols.`);
    this.emit('status_change', { status: this.status, stats: finalStats });
  }

  /**
   * Index a single root directory with batching and symbol extraction
   */
  async indexRoot(root, callbacks = {}) {
    if (this.isClosed) return { files: 0, folders: 0, symbols: 0 };
    const existingMtimes = this.db.getFilesMtimeMap(root.id);
    const scanned = await this.scanner.scanRoot(root, callbacks);
    if (this.isClosed) return { files: 0, folders: 0, symbols: 0 };

    // Batch insert directories
    this.db.batchInsertDirectories(scanned.directories);

    // Identify files that need insertion or symbol updates
    const filesToInsert = [];
    const codeFilesForSymbols = [];
    const currentPaths = new Set();

    for (const file of scanned.files) {
      currentPaths.add(file.path);
      const existing = existingMtimes.get(file.path);

      if (!existing || existing.mtime !== file.modified_time) {
        filesToInsert.push(file);
        if (this.symbolIndexer.isCodeFile(file.path)) {
          codeFilesForSymbols.push(file);
        }
      }
    }

    if (filesToInsert.length > 0 && !this.isClosed) {
      this.db.batchInsertFiles(filesToInsert);
    }

    // Prune deleted files that were in database but missing from current scan
    for (const [dbPath, rec] of existingMtimes) {
      if (this.isClosed) break;
      if (!currentPaths.has(dbPath)) {
        this.db.deleteFileByPath(dbPath);
      }
    }

    // Extract symbols for changed code files
    let symbolsExtracted = 0;
    for (const file of codeFilesForSymbols) {
      if (this.isClosed) break;
      const fileRecord = this.db.getFileByPath(file.path);
      if (fileRecord) {
        const symbols = await this.symbolIndexer.extractSymbols(file.path);
        if (symbols && symbols.length > 0 && !this.isClosed) {
          this.db.insertSymbols(fileRecord.id, root.id, symbols);
          symbolsExtracted += symbols.length;
        }
      }
    }

    if (!this.isClosed) {
      this.db.updateRootScanTime(root.id, Date.now());
    }

    return {
      files: scanned.files.length,
      folders: scanned.directories.length,
      symbols: symbolsExtracted
    };
  }

  /**
   * Handle single file change from watcher
   */
  async handleFileChangeEvent({ event, filePath, root, stat }) {
    if (this.isClosed) return;
    const normalized = path.normalize(filePath);
    if (this.scanner.isIgnoredFile(path.basename(normalized))) return;

    if (event === 'DELETE') {
      this.db.deleteFileByPath(normalized);
      this.emit('file_change', { event: 'DELETE', path: normalized, root: root.name });
      return;
    }

    // MODIFY or CREATE
    const fileRecord = await this.scanner.scanFile(normalized, root);
    if (fileRecord && !this.isClosed) {
      const fileId = this.db.insertOrUpdateFile(fileRecord);
      if (this.symbolIndexer.isCodeFile(normalized)) {
        const symbols = await this.symbolIndexer.extractSymbols(normalized);
        if (!this.isClosed) {
          this.db.insertSymbols(fileId, root.id, symbols);
        }
      }
      this.emit('file_change', { event: 'MODIFY', path: normalized, root: root.name, file: fileRecord });
    }
  }

  /**
   * Handle single directory change from watcher
   */
  async handleDirChangeEvent({ event, dirPath, root }) {
    if (this.isClosed) return;
    const normalized = path.normalize(dirPath);
    if (event === 'DELETE') {
      this.db.deleteDirectoryByPath(normalized);
      return;
    }
    const rel = path.relative(root.path, normalized);
    if (this.scanner.isIgnoredDir(path.basename(normalized), rel)) return;

    this.db.stmts.insertDir.run(
      root.id,
      normalized,
      rel,
      path.dirname(normalized),
      path.basename(normalized),
      0
    );
  }

  // --- Search Delegation ---

  searchFiles(query, options = {}) {
    return this.searchEngine.searchFiles(query, options);
  }

  searchFolders(query, options = {}) {
    return this.searchEngine.searchFolders(query, options);
  }

  searchSymbols(query, options = {}) {
    return this.searchEngine.searchSymbols(query, options);
  }

  async searchContent(query, options = {}) {
    return this.searchEngine.searchContent(query, options);
  }

  searchRecent(limit = 20, options = {}) {
    return this.searchEngine.searchRecent(limit, options);
  }

  searchLargeFiles(limit = 20, minSizeBytes = 10 * 1024 * 1024) {
    return this.searchEngine.searchLargeFiles(limit, minSizeBytes);
  }

  searchByExtension(extension, limit = 50) {
    return this.searchEngine.searchByExtension(extension, limit);
  }

  getFolderForFile(filePathOrName) {
    return this.searchEngine.getFolderForFile(filePathOrName);
  }

  getFileInfo(filePathOrName) {
    return this.searchEngine.getFileInfo(filePathOrName);
  }

  async searchProject(query, options = {}) {
    return this.searchEngine.searchProject(query, options);
  }

  // --- Roots Management ---

  getRoots() {
    return this.db.getRoots();
  }

  addRoot(name, rootPath, priority = 5) {
    const normalized = path.normalize(rootPath);
    if (!fs.existsSync(normalized)) {
      throw new Error(`Path does not exist: ${normalized}`);
    }
    if (/^[a-zA-Z]:\\?$/.test(normalized)) {
      throw new Error(`Cannot add entire drive '${normalized}' as a root.`);
    }

    const root = this.db.addRoot(name, normalized, priority, 1);
    this.watcher.watchRoot(root);
    // Index new root in background
    setTimeout(() => {
      if (!this.isClosed) {
        this.indexRoot(root).then(() => {
          if (!this.isClosed) this.emit('status_change', { status: this.status, stats: this.db.getStats() });
        }).catch(() => {});
      }
    }, 200);

    return root;
  }

  removeRoot(rootId) {
    this.watcher.unwatchRoot(rootId);
    return this.db.removeRoot(rootId);
  }

  // --- Rebuild ---

  async rebuildIndex() {
    if (this.isIndexing) {
      return { ok: false, message: 'Indexing is already in progress.' };
    }
    this.watcher.stop();
    this.db.clearAll();
    this.initDefaultRoots();
    const roots = this.db.getRoots();
    this.watcher.start(roots);
    this.reconcileAllRootsInBackground().catch(() => {});
    return { ok: true, message: 'Rebuild started in background.' };
  }

  // --- Open Action ---

  async openItem(filePathOrName, application = null) {
    const target = (filePathOrName || '').trim();
    if (!target) {
      return { ok: false, error: 'No path or name provided.' };
    }

    let itemPath = null;
    let isFolder = false;

    // Check if target is directly an existing filesystem path
    if (path.isAbsolute(target) && fs.existsSync(target)) {
      itemPath = path.normalize(target);
      isFolder = fs.statSync(itemPath).isDirectory();
    } else {
      // Resolve through indexed search
      const fileMatch = this.searchFiles(target, { limit: 1 })[0];
      if (fileMatch) {
        itemPath = fileMatch.absolute_path;
        isFolder = false;
      } else {
        const folderMatch = this.searchFolders(target, { limit: 1 })[0];
        if (folderMatch) {
          itemPath = folderMatch.absolute_path;
          isFolder = true;
        } else {
          const symMatch = this.searchSymbols(target, { limit: 1 })[0];
          if (symMatch) {
            itemPath = symMatch.file_path;
            isFolder = false;
          }
        }
      }
    }

    if (!itemPath || !fs.existsSync(itemPath)) {
      return { ok: false, error: `Could not find '${target}' in indexed workspace.` };
    }

    // Launch based on target type & requested application
    if (isFolder) {
      execFile('explorer.exe', [itemPath], { windowsHide: false }, () => {});
      return { ok: true, opened: itemPath, type: 'folder' };
    }

    if (/^(?:vs|vs\s*code|vscode|visual\s*studio\s*code|code)$/i.test(application || '')) {
      const codePaths = [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Microsoft VS Code', 'Code.exe'),
        'code'
      ];
      let launched = false;
      for (const cp of codePaths) {
        if (fs.existsSync(cp)) {
          spawn(cp, [itemPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
          launched = true;
          break;
        }
      }
      if (!launched) {
        // Fallback to powershell start
        execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process "${itemPath}"`], { windowsHide: true }, () => {});
      }
      return { ok: true, opened: itemPath, application: 'Visual Studio Code', type: 'file' };
    }

    // Default system open
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath "${itemPath}"`], { windowsHide: true }, () => {});
    return { ok: true, opened: itemPath, type: 'file' };
  }

  getStatus() {
    const stats = this.db.getStats();
    const watcherStatus = this.watcher.getStatus();
    return {
      status: this.status,
      files: stats.files,
      folders: stats.folders,
      symbols: stats.symbols,
      roots: stats.roots,
      lastScanTime: this.lastScanTime,
      watcher: watcherStatus.active ? 'ACTIVE' : 'INACTIVE',
      watcherDetails: watcherStatus,
      database: 'HEALTHY'
    };
  }

  stop() {
    this.isClosed = true;
    this.watcher.stop();
    this.db.close();
  }
}

module.exports = { ProjectIndexService };
