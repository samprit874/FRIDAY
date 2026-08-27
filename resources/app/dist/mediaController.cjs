'use strict';

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

class MediaController extends EventEmitter {
  constructor(options = {}) {
    super();
    this.scriptPath = options.scriptPath || path.join(__dirname, 'media_control.ps1');
    this.preferredApp = options.preferredApp || 'Spotify';
    this.enabled = options.enabled !== false;
    this.isWindows = process.platform === 'win32';
    this.monitorTimer = null;
    this.lastState = null;
    this.isPolling = false;
    this.lastLoggedTitle = '';
    this.lastLoggedState = '';
    this.lastSpotifyLaunch = 0;
  }

  /**
   * Check if Spotify was launched very recently and is still in warmup phase
   * @returns {boolean}
   */
  isSpotifyWarmingUp() {
    return (Date.now() - this.lastSpotifyLaunch) < 7000;
  }

  /**
   * Mark Spotify as just launched
   */
  markSpotifyLaunched() {
    this.lastSpotifyLaunch = Date.now();
    console.log('[MEDIA] Spotify marked as launched at', new Date(this.lastSpotifyLaunch).toISOString());
  }

  /**
   * Execute low-level GSMTC PowerShell command
   * @param {string} action 
   * @param {string} [targetApp] 
   * @param {number} [customTimeout]
   * @returns {Promise<any>}
   */
  execCommand(action, targetApp = '', customTimeout = 0) {
    if (!this.isWindows) {
      return Promise.resolve({
        ok: false,
        error: 'Windows GSMTC media control is only supported on Windows 10 and 11.'
      });
    }

    if (!fs.existsSync(this.scriptPath)) {
      return Promise.resolve({
        ok: false,
        error: `Media control script not found at ${this.scriptPath}`
      });
    }

    // Play and query actions may perform a session warm-up loop
    const actLower = String(action || '').toLowerCase().trim();
    const isWarmupAction = ['play', 'resume', 'start', 'toggle', 'now_playing', 'status'].includes(actLower);
    const timeoutMs = customTimeout > 0 ? customTimeout : (isWarmupAction ? 8500 : 5000);

    return new Promise((resolve) => {
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', this.scriptPath,
        '-Action', action
      ];

      if (targetApp && targetApp.trim()) {
        args.push('-TargetApp', targetApp.trim());
      }

      execFile('powershell.exe', args, { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
        if (err) {
          console.warn(`[MEDIA] PowerShell error for action '${action}':`, err.message);
          return resolve({
            ok: false,
            error: err.killed ? 'Media command timed out.' : (err.message || 'Media control execution error.')
          });
        }

        try {
          const raw = (stdout || '').trim();
          if (!raw) {
            return resolve({ ok: false, error: 'Empty response from media service.' });
          }
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (parseErr) {
          console.warn('[MEDIA] Failed to parse output:', stdout);
          resolve({ ok: false, error: 'Failed to parse media state.' });
        }
      });
    });
  }

  /**
   * Get all active media sessions
   */
  async getSessions() {
    console.log('[MEDIA] Searching for media sessions');
    const res = await this.execCommand('get_sessions');
    if (res.ok && Array.isArray(res.sessions)) {
      const spotifySession = res.sessions.find(s => (s.source || '').toLowerCase().includes('spotify'));
      if (spotifySession) {
        console.log('[MEDIA] Found Spotify session:', spotifySession.title || 'active');
      }
    }
    return res;
  }

  /**
   * Get current active media session track metadata
   * @param {string} [targetApp] 
   */
  async getNowPlaying(targetApp) {
    const app = targetApp || (this.preferredApp && this.preferredApp !== 'auto' ? this.preferredApp : '');
    const res = await this.execCommand('now_playing', app);
    return res;
  }

  /**
   * Get active playback status (Playing, Paused, etc.)
   * @param {string} [targetApp] 
   */
  async getStatus(targetApp) {
    const res = await this.getNowPlaying(targetApp);
    return res.ok ? { ok: true, status: res.playback_state, source: res.source } : res;
  }

  /**
   * Get timeline info (position, duration)
   * @param {string} [targetApp] 
   */
  async getTimeline(targetApp) {
    const res = await this.getNowPlaying(targetApp);
    return res.ok ? {
      ok: true,
      positionMs: res.position_ms,
      durationMs: res.duration_ms,
      source: res.source
    } : res;
  }

  /**
   * Send Play command (auto-launches Spotify and handles startup warmup if needed)
   * @param {string} [targetApp] 
   */
  async play(targetApp) {
    console.log('[MEDIA] Play command for target:', targetApp || this.preferredApp || 'auto');
    const app = targetApp || (this.preferredApp && this.preferredApp !== 'auto' ? this.preferredApp : 'Spotify');
    return await this.execCommand('play', app, 9000);
  }

  /**
   * Send Pause command
   * @param {string} [targetApp] 
   */
  async pause(targetApp) {
    console.log('[MEDIA] Pause command');
    return await this.execCommand('pause', targetApp);
  }

  /**
   * Toggle Play / Pause
   * @param {string} [targetApp] 
   */
  async toggle(targetApp) {
    console.log('[MEDIA] Toggle play/pause command');
    const app = targetApp || (this.preferredApp && this.preferredApp !== 'auto' ? this.preferredApp : 'Spotify');
    return await this.execCommand('toggle', app, 9000);
  }

  /**
   * Skip to next track
   * @param {string} [targetApp] 
   */
  async next(targetApp) {
    console.log('[MEDIA] Next command');
    return await this.execCommand('next', targetApp);
  }

  /**
   * Return to previous track
   * @param {string} [targetApp] 
   */
  async previous(targetApp) {
    console.log('[MEDIA] Previous command');
    return await this.execCommand('previous', targetApp);
  }

  /**
   * Start background state monitor
   * @param {number} [intervalMs=2500] 
   * @param {Function} [broadcastFn] 
   */
  startBackgroundMonitor(intervalMs = 2500, broadcastFn = null) {
    if (this.monitorTimer) return;
    if (!this.isWindows) return;

    const poll = async () => {
      if (this.isPolling) return;
      this.isPolling = true;

      try {
        const state = await this.getNowPlaying();
        if (state && state.ok) {
          const currentTitle = `${state.title} - ${state.artist}`;
          const currentPbState = state.playback_state;

          if (currentTitle !== this.lastLoggedTitle && state.title) {
            console.log(`[MEDIA] Track changed: "${state.title}" by ${state.artist || 'Unknown'} (${state.source})`);
            this.lastLoggedTitle = currentTitle;
            this.emit('trackChange', state);
          }

          if (currentPbState !== this.lastLoggedState && currentPbState) {
            console.log(`[MEDIA] Playback state changed: ${currentPbState} (${state.source})`);
            this.lastLoggedState = currentPbState;
            this.emit('playbackStateChange', state);
          }

          this.lastState = state;
          this.emit('stateUpdate', state);

          if (typeof broadcastFn === 'function') {
            broadcastFn(state);
          }
        } else if (this.lastState && this.lastState.ok) {
          // Media session closed
          this.lastState = { ok: false, playback_state: 'Closed' };
          this.lastLoggedTitle = '';
          this.lastLoggedState = 'Closed';
          this.emit('stateUpdate', this.lastState);
          if (typeof broadcastFn === 'function') {
            broadcastFn(this.lastState);
          }
        }
      } catch (err) {
        // Silent fail for polling
      } finally {
        this.isPolling = false;
        // Adaptive polling: if playing, poll every 2.5s; if closed, poll every 5s
        const nextDelay = (this.lastState && this.lastState.playback_state === 'Playing') ? 2500 : 4500;
        this.monitorTimer = setTimeout(poll, nextDelay);
      }
    };

    this.monitorTimer = setTimeout(poll, 1500);
    console.log('[MEDIA] Background state monitor started.');
  }

  /**
   * Stop background monitor
   */
  stopBackgroundMonitor() {
    if (this.monitorTimer) {
      clearTimeout(this.monitorTimer);
      this.monitorTimer = null;
      console.log('[MEDIA] Background state monitor stopped.');
    }
  }
}

module.exports = { MediaController };
