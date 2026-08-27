'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const TEXT_EXTENSIONS = new Set([
  '.py', '.pyw',
  '.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.json', '.json5', '.jsonc',
  '.md', '.markdown', '.txt', '.rst',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ps1', '.psm1', '.bat', '.cmd', '.sh', '.bash',
  '.sql', '.sqlite3', '.graphql', '.gql',
  '.env', '.gitignore', '.editorconfig',
  '.c', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.java', '.kt'
]);

const BINARY_EXTENSIONS = new Set([
  '.exe', '.dll', '.so', '.dylib', '.bin', '.pak', '.dat',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svgz',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mkv', '.avi',
  '.zip', '.tar', '.gz', '.7z', '.rar', '.pdf', '.docx', '.xlsx'
]);

const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

/**
 * High-Speed Content Search Engine for FRIDAY
 */
class ContentSearcher {
  constructor(options = {}) {
    this.maxFileSize = options.maxFileSize || DEFAULT_MAX_FILE_SIZE;
  }

  isSearchableTextFile(filePath, size = 0) {
    if (size > this.maxFileSize) return false;
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return false;
    if (TEXT_EXTENSIONS.has(ext)) return true;
    // Known files without extensions
    const basename = path.basename(filePath).toLowerCase();
    if (['dockerfile', 'makefile', 'license', 'readme'].includes(basename)) return true;
    return false;
  }

  /**
   * Fast check if a file buffer contains null bytes (binary indicator)
   */
  async isBinaryFile(filePath) {
    try {
      const fd = await fs.promises.open(filePath, 'r');
      const buffer = Buffer.alloc(1024);
      const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
      await fd.close();
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  /**
   * Search within a single text file
   * @param {string} filePath Absolute path
   * @param {string|RegExp} query Search query
   * @param {Object} [options] { maxMatches, caseSensitive }
   * @returns {Promise<Array<{ line: number, text: string }>>}
   */
  async searchInFile(filePath, query, options = {}) {
    const maxMatches = options.maxMatches || 20;
    const caseSensitive = Boolean(options.caseSensitive);
    const matches = [];

    let regex;
    if (query instanceof RegExp) {
      regex = query;
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
    }

    try {
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      let lineNum = 0;
      for await (const line of rl) {
        lineNum++;
        if (regex.test(line)) {
          matches.push({
            line: lineNum,
            text: line.trim()
          });
          if (matches.length >= maxMatches) {
            rl.close();
            fileStream.destroy();
            break;
          }
        }
        // Reset regex index if global
        regex.lastIndex = 0;
      }
      return matches;
    } catch {
      return [];
    }
  }

  /**
   * Search across a list of candidate files with concurrency control
   * @param {Array<Object>} files List of file records { path, relative_path, size, name }
   * @param {string} query Search query
   * @param {Object} [options] { limit, maxMatchesPerFile, caseSensitive }
   * @returns {Promise<Array<Object>>}
   */
  async searchFilesContent(files, query, options = {}) {
    if (!query || !files || files.length === 0) return [];
    const limit = options.limit || 50;
    const maxMatchesPerFile = options.maxMatchesPerFile || 5;
    const concurrency = 16;
    const results = [];

    // Filter to text candidate files
    const candidates = files.filter(f => this.isSearchableTextFile(f.path, f.size));

    let candidateIdx = 0;
    const workers = [];

    const worker = async () => {
      while (candidateIdx < candidates.length && results.length < limit) {
        const file = candidates[candidateIdx++];
        if (!file) break;

        const matches = await this.searchInFile(file.path, query, {
          maxMatches: maxMatchesPerFile,
          caseSensitive: options.caseSensitive
        });

        if (matches.length > 0) {
          results.push({
            file_id: file.id,
            root_id: file.root_id,
            name: file.name,
            path: file.path,
            relative_path: file.relative_path,
            parent_dir: file.parent_dir,
            extension: file.extension,
            size: file.size,
            matches
          });
        }
      }
    };

    for (let i = 0; i < Math.min(concurrency, candidates.length); i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
    return results.slice(0, limit);
  }
}

module.exports = { ContentSearcher, TEXT_EXTENSIONS, BINARY_EXTENSIONS };
