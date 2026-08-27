'use strict';

const path = require('node:path');
const { fuzzyMatch, rankResults } = require('./fuzzy.cjs');
const { ContentSearcher } = require('./content_search.cjs');

/**
 * High-Speed Search Engine for FRIDAY Multi-Root Index
 */
class SearchEngine {
  /**
   * @param {import('./database.cjs').IndexDatabase} db
   * @param {Object} [options]
   */
  constructor(db, options = {}) {
    this.db = db;
    this.contentSearcher = new ContentSearcher(options);
    this.prepareSearchStatements();
  }

  prepareSearchStatements() {
    const rawDb = this.db.db;
    this.searchStmts = {
      exactFileName: rawDb.prepare(`
        SELECT f.*, r.name AS root_name
        FROM files f
        JOIN roots r ON f.root_id = r.id
        WHERE f.name = ? COLLATE NOCASE
        ORDER BY r.priority ASC, f.modified_time DESC
        LIMIT ?
      `),

      prefixFileName: rawDb.prepare(`
        SELECT f.*, r.name AS root_name
        FROM files f
        JOIN roots r ON f.root_id = r.id
        WHERE f.name LIKE ? COLLATE NOCASE
        ORDER BY r.priority ASC, length(f.name) ASC, f.modified_time DESC
        LIMIT ?
      `),

      substringFileName: rawDb.prepare(`
        SELECT f.*, r.name AS root_name
        FROM files f
        JOIN roots r ON f.root_id = r.id
        WHERE f.name LIKE ? COLLATE NOCASE
        ORDER BY r.priority ASC, length(f.name) ASC, f.modified_time DESC
        LIMIT ?
      `),

      pathSearch: rawDb.prepare(`
        SELECT f.*, r.name AS root_name
        FROM files f
        JOIN roots r ON f.root_id = r.id
        WHERE f.relative_path LIKE ? COLLATE NOCASE OR f.path LIKE ? COLLATE NOCASE
        ORDER BY r.priority ASC, length(f.relative_path) ASC, f.modified_time DESC
        LIMIT ?
      `),

      byExtension: rawDb.prepare(`
        SELECT f.*, r.name AS root_name
        FROM files f
        JOIN roots r ON f.root_id = r.id
        WHERE f.extension = ? COLLATE NOCASE
        ORDER BY r.priority ASC, f.modified_time DESC
        LIMIT ?
      `),

      recentFiles: rawDb.prepare(`
        SELECT f.*, r.name AS root_name
        FROM files f
        JOIN roots r ON f.root_id = r.id
        WHERE f.is_directory = 0
        ORDER BY f.modified_time DESC
        LIMIT ?
      `),

      recentFilesByExt: rawDb.prepare(`
        SELECT f.*, r.name AS root_name
        FROM files f
        JOIN roots r ON f.root_id = r.id
        WHERE f.is_directory = 0 AND f.extension = ? COLLATE NOCASE
        ORDER BY f.modified_time DESC
        LIMIT ?
      `),

      largeFiles: rawDb.prepare(`
        SELECT f.*, r.name AS root_name
        FROM files f
        JOIN roots r ON f.root_id = r.id
        WHERE f.is_directory = 0 AND f.size >= ?
        ORDER BY f.size DESC
        LIMIT ?
      `),

      // Directories
      exactDirName: rawDb.prepare(`
        SELECT d.*, r.name AS root_name
        FROM directories d
        JOIN roots r ON d.root_id = r.id
        WHERE d.name = ? COLLATE NOCASE
        ORDER BY r.priority ASC, d.id ASC
        LIMIT ?
      `),

      prefixDirName: rawDb.prepare(`
        SELECT d.*, r.name AS root_name
        FROM directories d
        JOIN roots r ON d.root_id = r.id
        WHERE d.name LIKE ? COLLATE NOCASE
        ORDER BY r.priority ASC, length(d.name) ASC
        LIMIT ?
      `),

      substringDirName: rawDb.prepare(`
        SELECT d.*, r.name AS root_name
        FROM directories d
        JOIN roots r ON d.root_id = r.id
        WHERE d.name LIKE ? COLLATE NOCASE OR d.relative_path LIKE ? COLLATE NOCASE
        ORDER BY r.priority ASC, length(d.name) ASC
        LIMIT ?
      `),

      // Symbols
      exactSymbol: rawDb.prepare(`
        SELECT s.*, f.name AS file_name, f.path AS file_path, f.relative_path, r.name AS root_name
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        JOIN roots r ON s.root_id = r.id
        WHERE s.symbol_name = ? COLLATE NOCASE
        ORDER BY r.priority ASC, s.line_number ASC
        LIMIT ?
      `),

      prefixSymbol: rawDb.prepare(`
        SELECT s.*, f.name AS file_name, f.path AS file_path, f.relative_path, r.name AS root_name
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        JOIN roots r ON s.root_id = r.id
        WHERE s.symbol_name LIKE ? COLLATE NOCASE
        ORDER BY r.priority ASC, length(s.symbol_name) ASC
        LIMIT ?
      `),

      substringSymbol: rawDb.prepare(`
        SELECT s.*, f.name AS file_name, f.path AS file_path, f.relative_path, r.name AS root_name
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        JOIN roots r ON s.root_id = r.id
        WHERE s.symbol_name LIKE ? COLLATE NOCASE
        ORDER BY r.priority ASC, length(s.symbol_name) ASC
        LIMIT ?
      `),

      // Candidate files for content search
      textCandidateFiles: rawDb.prepare(`
        SELECT id, root_id, path, relative_path, parent_dir, name, extension, size, modified_time
        FROM files
        WHERE is_directory = 0 AND size <= ?
        ORDER BY modified_time DESC
        LIMIT ?
      `),

      textCandidateFilesByRoot: rawDb.prepare(`
        SELECT id, root_id, path, relative_path, parent_dir, name, extension, size, modified_time
        FROM files
        WHERE root_id = ? AND is_directory = 0 AND size <= ?
        ORDER BY modified_time DESC
        LIMIT ?
      `)
    };
  }

  formatFileRecord(r) {
    return {
      id: r.id,
      name: r.name,
      relative_path: r.relative_path,
      absolute_path: r.path,
      parent_dir: r.parent_dir,
      root_id: r.root_id,
      root_name: r.root_name || 'Root',
      type: r.is_directory ? 'folder' : 'file',
      extension: r.extension,
      size: r.size,
      modified_time: r.modified_time,
      created_time: r.created_time
    };
  }

  formatDirRecord(r) {
    return {
      id: r.id,
      name: r.name,
      relative_path: r.relative_path,
      absolute_path: r.path,
      parent_dir: r.parent_dir,
      root_id: r.root_id,
      root_name: r.root_name || 'Root',
      type: 'folder',
      file_count: r.file_count
    };
  }

  formatSymbolRecord(r) {
    return {
      id: r.id,
      name: r.symbol_name,
      symbol_type: r.symbol_type,
      line_number: r.line_number,
      parent_symbol: r.parent_symbol,
      signature: r.signature,
      file_id: r.file_id,
      file_name: r.file_name,
      file_path: r.file_path,
      relative_path: r.relative_path,
      root_id: r.root_id,
      root_name: r.root_name,
      type: 'symbol'
    };
  }

  /**
   * Search files by query (supports exact, prefix, substring, path, and fuzzy)
   */
  searchFiles(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    const q = query.trim();
    const limit = options.limit || 30;
    const extension = options.extension ? (options.extension.startsWith('.') ? options.extension : '.' + options.extension) : null;

    // Check if query is looking for a path with slashes
    const isPathQuery = q.includes('/') || q.includes('\\');

    const seenPaths = new Set();
    const results = [];

    // Helper to add unique records
    const addRecords = (records) => {
      for (const r of records) {
        if (!seenPaths.has(r.path) && results.length < limit) {
          seenPaths.add(r.path);
          results.push(this.formatFileRecord(r));
        }
      }
    };

    if (extension && !q.includes('.')) {
      const extMatches = this.searchStmts.byExtension.all(extension.toLowerCase(), limit * 2);
      const ranked = rankResults(extMatches, q, item => item.name);
      addRecords(ranked);
      return results.slice(0, limit);
    }

    if (isPathQuery) {
      const pathPattern = `%${q.replace(/[/\\]+/g, '%')}%`;
      const pathMatches = this.searchStmts.pathSearch.all(pathPattern, pathPattern, limit);
      addRecords(pathMatches);
    } else {
      // 1. Exact match
      const exactMatches = this.searchStmts.exactFileName.all(q, limit);
      addRecords(exactMatches);

      // 2. Prefix match
      if (results.length < limit) {
        const prefixMatches = this.searchStmts.prefixFileName.all(`${q}%`, limit);
        addRecords(prefixMatches);
      }

      // 3. Substring match
      if (results.length < limit) {
        const subMatches = this.searchStmts.substringFileName.all(`%${q}%`, limit * 2);
        const ranked = rankResults(subMatches, q, item => item.name);
        addRecords(ranked);
      }

      // 4. Fuzzy fallback if fewer than limit results
      if (results.length < 5 && q.length >= 3) {
        // Query candidate files from active roots for fuzzy ranking
        const candidateSql = `
          SELECT f.*, r.name AS root_name
          FROM files f
          JOIN roots r ON f.root_id = r.id
          WHERE f.is_directory = 0
          ORDER BY r.priority ASC, f.modified_time DESC
          LIMIT 2000
        `;
        const candidates = this.db.db.prepare(candidateSql).all();
        const fuzzyRanked = rankResults(candidates, q, item => item.name);
        addRecords(fuzzyRanked);
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Search folders / directories
   */
  searchFolders(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    const q = query.trim();
    const limit = options.limit || 20;

    const seenPaths = new Set();
    const results = [];

    const addRecords = (records) => {
      for (const r of records) {
        if (!seenPaths.has(r.path) && results.length < limit) {
          seenPaths.add(r.path);
          results.push(this.formatDirRecord(r));
        }
      }
    };

    // 1. Exact directory name
    const exactMatches = this.searchStmts.exactDirName.all(q, limit);
    addRecords(exactMatches);

    // 2. Prefix directory name
    if (results.length < limit) {
      const prefixMatches = this.searchStmts.prefixDirName.all(`${q}%`, limit);
      addRecords(prefixMatches);
    }

    // 3. Substring directory / relative path
    if (results.length < limit) {
      const subPattern = `%${q}%`;
      const subMatches = this.searchStmts.substringDirName.all(subPattern, subPattern, limit);
      addRecords(subMatches);
    }

    return results.slice(0, limit);
  }

  /**
   * Search code symbols (classes, functions, methods)
   */
  searchSymbols(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    const q = query.trim();
    const limit = options.limit || 30;

    const seen = new Set();
    const results = [];

    const addRecords = (records) => {
      for (const r of records) {
        const key = `${r.file_path}:${r.line_number}:${r.symbol_name}`;
        if (!seen.has(key) && results.length < limit) {
          seen.add(key);
          results.push(this.formatSymbolRecord(r));
        }
      }
    };

    // 1. Exact symbol name
    const exactMatches = this.searchStmts.exactSymbol.all(q, limit);
    addRecords(exactMatches);

    // 2. Prefix symbol name
    if (results.length < limit) {
      const prefixMatches = this.searchStmts.prefixSymbol.all(`${q}%`, limit);
      addRecords(prefixMatches);
    }

    // 3. Substring symbol name
    if (results.length < limit) {
      const subMatches = this.searchStmts.substringSymbol.all(`%${q}%`, limit * 2);
      const ranked = rankResults(subMatches, q, item => item.symbol_name);
      addRecords(ranked);
    }

    return results.slice(0, limit);
  }

  /**
   * Search file contents
   */
  async searchContent(query, options = {}) {
    if (!query || typeof query !== 'string') return [];
    const q = query.trim();
    const limit = options.limit || 30;
    const rootId = options.root_id || null;
    const maxFileSize = options.maxFileSize || 2 * 1024 * 1024;

    const maxCandidates = 1500;
    let candidates;
    if (rootId) {
      candidates = this.searchStmts.textCandidateFilesByRoot.all(rootId, maxFileSize, maxCandidates);
    } else {
      candidates = this.searchStmts.textCandidateFiles.all(maxFileSize, maxCandidates);
    }

    const matches = await this.contentSearcher.searchFilesContent(candidates, q, {
      limit,
      maxMatchesPerFile: options.maxMatchesPerFile || 4,
      caseSensitive: options.caseSensitive
    });

    return matches.map(m => ({
      ...m,
      type: 'content'
    }));
  }

  /**
   * Search recent files
   */
  searchRecent(limit = 20, options = {}) {
    if (options.extension) {
      const ext = options.extension.startsWith('.') ? options.extension : '.' + options.extension;
      const rows = this.searchStmts.recentFilesByExt.all(ext.toLowerCase(), limit);
      return rows.map(r => this.formatFileRecord(r));
    }
    const rows = this.searchStmts.recentFiles.all(limit);
    return rows.map(r => this.formatFileRecord(r));
  }

  /**
   * Search large files
   */
  searchLargeFiles(limit = 20, minSizeBytes = 10 * 1024 * 1024) {
    const rows = this.searchStmts.largeFiles.all(minSizeBytes, limit);
    return rows.map(r => this.formatFileRecord(r));
  }

  /**
   * Search files by extension
   */
  searchByExtension(extension, limit = 50) {
    const ext = extension.startsWith('.') ? extension : '.' + extension;
    const rows = this.searchStmts.byExtension.all(ext.toLowerCase(), limit);
    return rows.map(r => this.formatFileRecord(r));
  }

  /**
   * Get folder for a file or folder query
   */
  getFolderForFile(filePathOrName) {
    const q = (filePathOrName || '').trim();
    if (!q) return null;

    // Check if it's already an existing directory
    const dirMatch = this.searchFolders(q, { limit: 1 })[0];
    if (dirMatch) {
      return dirMatch;
    }

    // Check if it's a file
    const fileMatch = this.searchFiles(q, { limit: 1 })[0];
    if (fileMatch) {
      return {
        name: path.basename(fileMatch.parent_dir),
        absolute_path: fileMatch.parent_dir,
        relative_path: path.dirname(fileMatch.relative_path),
        root_id: fileMatch.root_id,
        root_name: fileMatch.root_name,
        type: 'folder',
        matched_file: fileMatch.name
      };
    }

    // Check symbol match
    const symbolMatch = this.searchSymbols(q, { limit: 1 })[0];
    if (symbolMatch) {
      return {
        name: path.basename(path.dirname(symbolMatch.file_path)),
        absolute_path: path.dirname(symbolMatch.file_path),
        relative_path: path.dirname(symbolMatch.relative_path),
        root_id: symbolMatch.root_id,
        root_name: symbolMatch.root_name,
        type: 'folder',
        matched_symbol: symbolMatch.name,
        matched_file: symbolMatch.file_name
      };
    }

    return null;
  }

  /**
   * Get detailed metadata for file
   */
  getFileInfo(filePathOrName) {
    const q = (filePathOrName || '').trim();
    if (!q) return null;

    const file = this.searchFiles(q, { limit: 1 })[0];
    if (!file) return null;

    // Fetch attached symbols
    const symSql = `
      SELECT symbol_name AS name, symbol_type AS type, line_number AS line, parent_symbol AS parent, signature
      FROM symbols
      WHERE file_id = ?
      ORDER BY line_number ASC
    `;
    const symbols = this.db.db.prepare(symSql).all(file.id);

    return {
      ...file,
      symbols
    };
  }

  /**
   * Unified multi-faceted project search (combining files, folders, symbols, and content)
   */
  async searchProject(query, options = {}) {
    if (!query || typeof query !== 'string') return { files: [], folders: [], symbols: [], content: [] };
    const q = query.trim();
    const limit = options.limit || 20;

    const files = this.searchFiles(q, { limit });
    const folders = this.searchFolders(q, { limit: 10 });
    const symbols = this.searchSymbols(q, { limit: 15 });

    let content = [];
    if (options.includeContent !== false && (files.length === 0 || options.includeContent === true)) {
      content = await this.searchContent(q, { limit: 10 });
    }

    return {
      query: q,
      files,
      folders,
      symbols,
      content
    };
  }
}

module.exports = { SearchEngine };
