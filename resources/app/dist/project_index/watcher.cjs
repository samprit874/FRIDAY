'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * High-Speed Multi-Root Filesystem Watcher with Resilient Fallback for FRIDAY
 */
class IndexWatcher {
  /**
   * @param {Object} options
   * @param {Function} options.onFileChange Callback ({ event, filePath, root }) => void
   * @param {Function} options.onDirChange Callback ({ event, dirPath, root }) => void
   * @param {Set<string>} [options.ignoreDirs]
   * @param {number} [options.debounceMs]
   */
  constructor(options = {}) {
    this.onFileChange = options.onFileChange || (() => {});
    this.onDirChange = options.onDirChange || (() => {});
    this.ignoreDirs = options.ignoreDirs || new Set();
    this.debounceMs = options.debounceMs || 250;

    this.watchers = new Map(); // rootId -> FSWatcher
    this.fallbackRoots = new Set(); // rootIds using fallback polling
    this.pendingEvents = new Map(); // path -> { timer, event, root }
    this.isWatching = false;
    this.fallbackInterval = null;
  }

  isIgnored(relPath) {
    if (!relPath) return false;
    const parts = relPath.replace(/\\/g, '/').split('/');
    for (const p of parts) {
      if (this.ignoreDirs.has(p)) return true;
      if (p.startsWith('.git') || p === 'node_modules' || p === '__pycache__' || p.startsWith('.venv') || p === 'venv') {
        return true;
      }
    }
    return false;
  }

  /**
   * Watch a specific root directory
   * @param {Object} root { id, path, name }
   */
  watchRoot(root) {
    const rootPath = path.normalize(root.path);
    if (this.watchers.has(root.id)) {
      this.unwatchRoot(root.id);
    }

    if (!fs.existsSync(rootPath)) {
      console.warn(`[Watcher] Cannot watch non-existent root: ${rootPath}`);
      return false;
    }

    // Try native recursive fs.watch on Windows
    try {
      const watcher = fs.watch(rootPath, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        if (this.isIgnored(filename)) return;

        const fullPath = path.join(rootPath, filename);
        this.queueEvent(eventType, fullPath, root);
      });

      watcher.on('error', (err) => {
        console.warn(`[Watcher] Native watch error on ${root.name} (${rootPath}): ${err.message}. Switching to fallback.`);
        this.unwatchRoot(root.id);
        this.fallbackRoots.add(root.id);
      });

      this.watchers.set(root.id, watcher);
      this.fallbackRoots.delete(root.id);
      console.log(`[Watcher] Native watcher active for [${root.name}]: ${rootPath}`);
      return true;
    } catch (err) {
      console.warn(`[Watcher] Could not start native watcher for ${root.name}: ${err.message}. Using fallback reconciliation.`);
      this.fallbackRoots.add(root.id);
      return false;
    }
  }

  unwatchRoot(rootId) {
    const watcher = this.watchers.get(rootId);
    if (watcher) {
      try { watcher.close(); } catch {}
      this.watchers.delete(rootId);
    }
    this.fallbackRoots.delete(rootId);
  }

  queueEvent(eventType, fullPath, root) {
    const normPath = path.normalize(fullPath);

    if (this.pendingEvents.has(normPath)) {
      clearTimeout(this.pendingEvents.get(normPath).timer);
    }

    const timer = setTimeout(async () => {
      this.pendingEvents.delete(normPath);
      await this.processFsEvent(eventType, normPath, root);
    }, this.debounceMs);

    this.pendingEvents.set(normPath, { timer, event: eventType, root });
  }

  async processFsEvent(eventType, fullPath, root) {
    let exists = false;
    let stat = null;

    try {
      stat = await fs.promises.stat(fullPath);
      exists = true;
    } catch {
      exists = false;
    }

    if (!exists) {
      // File or Directory deleted / moved away
      this.onFileChange({
        event: 'DELETE',
        filePath: fullPath,
        root
      });
      this.onDirChange({
        event: 'DELETE',
        dirPath: fullPath,
        root
      });
      return;
    }

    if (stat.isDirectory()) {
      this.onDirChange({
        event: 'MODIFY',
        dirPath: fullPath,
        root,
        stat
      });
    } else if (stat.isFile()) {
      this.onFileChange({
        event: 'MODIFY',
        filePath: fullPath,
        root,
        stat
      });
    }
  }

  /**
   * Start watching multiple roots
   * @param {Array<Object>} roots
   */
  start(roots = []) {
    this.isWatching = true;
    for (const root of roots) {
      if (root.enabled) {
        this.watchRoot(root);
      }
    }

    // Start fallback reconciliation timer (runs every 45s for roots where native watcher failed)
    if (!this.fallbackInterval) {
      this.fallbackInterval = setInterval(() => {
        if (this.fallbackRoots.size > 0 && typeof this.onFallbackPoll === 'function') {
          this.onFallbackPoll([...this.fallbackRoots]);
        }
      }, 45000);
    }
  }

  stop() {
    this.isWatching = false;
    for (const [id, watcher] of this.watchers) {
      try { watcher.close(); } catch {}
    }
    this.watchers.clear();
    this.fallbackRoots.clear();

    for (const [_, item] of this.pendingEvents) {
      clearTimeout(item.timer);
    }
    this.pendingEvents.clear();

    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
  }

  getStatus() {
    return {
      active: this.isWatching && (this.watchers.size > 0 || this.fallbackRoots.size > 0),
      nativeWatchers: this.watchers.size,
      fallbackRoots: this.fallbackRoots.size,
      watchedRoots: [...this.watchers.keys()]
    };
  }
}

module.exports = { IndexWatcher };
