'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PYTHON_EXTENSIONS = new Set(['.py', '.pyw']);
const JS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs']);

/**
 * Multi-Language Code Symbol Indexer for FRIDAY
 */
class SymbolIndexer {
  constructor(options = {}) {
    this.pythonPath = options.pythonPath || this.detectPython();
    this.extractorScript = path.join(__dirname, 'extract_symbols.py');
  }

  detectPython() {
    const candidates = [
      process.env.FRIDAY_PYTHON,
      path.resolve(__dirname, '..', '..', '..', 'agent', '_internal', 'python.exe'),
      'python',
      'python3'
    ].filter(Boolean);

    for (const cand of candidates) {
      try {
        require('node:child_process').execSync(`"${cand}" --version`, { stdio: 'ignore', timeout: 1500 });
        return cand;
      } catch {}
    }
    return 'python';
  }

  /**
   * Extract symbols from a single file based on extension
   * @param {string} filePath Absolute path
   * @returns {Promise<Array<{name: string, type: string, line: number, parent: string|null, signature: string}>>}
   */
  async extractSymbols(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (PYTHON_EXTENSIONS.has(ext)) {
      return this.extractPythonSymbols(filePath);
    } else if (JS_EXTENSIONS.has(ext)) {
      return this.extractJsSymbols(filePath);
    }
    return [];
  }

  /**
   * Python symbol extraction via AST
   */
  extractPythonSymbols(filePath) {
    return new Promise((resolve) => {
      try {
        if (!fs.existsSync(filePath)) return resolve([]);
        const proc = spawn(this.pythonPath, [this.extractorScript, filePath], {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.on('error', () => resolve([]));
        proc.on('close', (code) => {
          if (code !== 0 || !stdout.trim()) {
            return resolve([]);
          }
          try {
            const syms = JSON.parse(stdout.trim());
            resolve(Array.isArray(syms) ? syms : []);
          } catch {
            resolve([]);
          }
        });
      } catch {
        resolve([]);
      }
    });
  }

  /**
   * Batch Python symbol extraction (streaming list of file paths to python extractor)
   */
  async batchExtractPythonSymbols(filePaths) {
    if (!filePaths || filePaths.length === 0) return {};
    return new Promise((resolve) => {
      try {
        const proc = spawn(this.pythonPath, [this.extractorScript], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.on('error', () => resolve({}));
        proc.on('close', (code) => {
          if (code !== 0 || !stdout.trim()) return resolve({});
          try {
            const res = JSON.parse(stdout.trim());
            resolve(res || {});
          } catch {
            resolve({});
          }
        });

        proc.stdin.write(JSON.stringify(filePaths));
        proc.stdin.end();
      } catch {
        resolve({});
      }
    });
  }

  /**
   * High-speed JS / TS AST & regex symbol extractor
   */
  async extractJsSymbols(filePath) {
    try {
      if (!fs.existsSync(filePath)) return [];
      const content = await fs.promises.readFile(filePath, 'utf-8');
      const lines = content.split(/\r?\n/);
      const symbols = [];
      let currentClass = null;

      const classRegex = /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)(?:\s+extends\s+([A-Za-z0-9_$.]+))?/;
      const funcRegex = /^\s*(?:export\s+(?:default\s+)?)?(async\s+)?function(?:\s*\*|\s+)?([A-Za-z0-9_$]+)?\s*\(([^)]*)\)/;
      const arrowRegex = /^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(async\s+)?(?:\(([^)]*)\)|[A-Za-z0-9_$]+)\s*=>/;
      const methodRegex = /^\s*(async\s+)?([A-Za-z0-9_$]+)\s*\(([^)]*)\)\s*\{/;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        // Skip comments and empty lines
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;

        // Class
        const classMatch = line.match(classRegex);
        if (classMatch) {
          const className = classMatch[1];
          const bases = classMatch[2] ? ` extends ${classMatch[2]}` : '';
          symbols.push({
            name: className,
            type: 'class',
            line: lineNum,
            parent: null,
            signature: `class ${className}${bases}`
          });
          currentClass = className;
          continue;
        }

        // Method inside class
        if (currentClass) {
          // Check if class closed
          if (/^\s*\}/.test(line) && !line.includes('{')) {
            currentClass = null;
            continue;
          }
          const methodMatch = line.match(methodRegex);
          if (methodMatch && !['if', 'for', 'while', 'switch', 'catch'].includes(methodMatch[2])) {
            const isAsync = Boolean(methodMatch[1]);
            const methodName = methodMatch[2];
            const args = methodMatch[3] || '';
            symbols.push({
              name: methodName,
              type: 'method',
              line: lineNum,
              parent: currentClass,
              signature: `${isAsync ? 'async ' : ''}${methodName}(${args.trim()})`
            });
            continue;
          }
        }

        // Standard function
        const funcMatch = line.match(funcRegex);
        if (funcMatch && funcMatch[2]) {
          const isAsync = Boolean(funcMatch[1]);
          const funcName = funcMatch[2];
          const args = funcMatch[3] || '';
          symbols.push({
            name: funcName,
            type: isAsync ? 'async_function' : 'function',
            line: lineNum,
            parent: null,
            signature: `${isAsync ? 'async ' : ''}function ${funcName}(${args.trim()})`
          });
          continue;
        }

        // Const arrow function
        const arrowMatch = line.match(arrowRegex);
        if (arrowMatch) {
          const funcName = arrowMatch[1];
          const isAsync = Boolean(arrowMatch[2]);
          const args = arrowMatch[3] || '';
          symbols.push({
            name: funcName,
            type: isAsync ? 'async_function' : 'function',
            line: lineNum,
            parent: null,
            signature: `const ${funcName} = ${isAsync ? 'async ' : ''}(${args.trim()}) =>`
          });
        }
      }

      return symbols;
    } catch {
      return [];
    }
  }

  isCodeFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return PYTHON_EXTENSIONS.has(ext) || JS_EXTENSIONS.has(ext);
  }
}

module.exports = { SymbolIndexer, PYTHON_EXTENSIONS, JS_EXTENSIONS };
