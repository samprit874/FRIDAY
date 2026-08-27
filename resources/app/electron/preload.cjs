/* ===========================================================================
 * FRIDAY — Electron preload
 * ---------------------------------------------------------------------------
 * Runs in an isolated context and exposes a minimal, explicit API surface to
 * the renderer via contextBridge. In Phase 1 this only advertises that the UI
 * is running inside the desktop shell (so the web UI can adapt if it wants);
 * tray/notification/window controls are added alongside those features.
 * ========================================================================= */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const desktopApi = {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
  hideToTray: () => ipcRenderer.send('friday:hide-to-tray'),
  showWindow: (bringOnline = true) => ipcRenderer.send('friday:show-window', bringOnline),
  goOffline: () => ipcRenderer.send('friday:go-offline'),
  comeOnline: () => ipcRenderer.send('friday:come-online'),
  showScreenGlow: (mode = 'active', options = {}) => ipcRenderer.send('friday:screen-glow-show', mode, options),
  hideScreenGlow: () => ipcRenderer.send('friday:screen-glow-hide'),
  flashScreenGlow: (durationMs = 2600, options = {}) => ipcRenderer.send('friday:screen-glow-flash', durationMs, options),
  pauseScreenGlow: () => ipcRenderer.send('friday:screen-glow-pause'),
  showNotification: (title, body, options = {}) => ipcRenderer.send('friday:show-notification', title, body, options),
  showDynamicIsland: (notifData) => ipcRenderer.send('friday:show-dynamic-island', notifData),
  
  restartApp: () => ipcRenderer.send('friday:restart-app'),
  relaunchApp: () => ipcRenderer.send('friday:restart-app'),
};
contextBridge.exposeInMainWorld('friday', desktopApi);

function isWakeWordEnabled() {
  try {
    const settings = JSON.parse(window.localStorage.getItem('friday.settings.v2') || '{}');
    return settings.wakeWordEnabled !== false;
  } catch {
    return true;
  }
}

function activateFridayFromWakeWord() {
  if (!isWakeWordEnabled()) return;
  const wakeButton = [...document.querySelectorAll('button')]
    .find((button) => button.title === 'Awake Friday');
  wakeButton?.click();
}

function sleepFriday() {
  const sleepButton = [...document.querySelectorAll('button')]
    .find((button) => button.title === 'Sleep core');
  sleepButton?.click();
}

ipcRenderer.on('friday:wake-word', () => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', activateFridayFromWakeWord, { once: true });
  } else {
    activateFridayFromWakeWord();
  }
});

ipcRenderer.on('friday:come-online', () => {
  try {
    fetch('http://127.0.0.1:4321/api/operating/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'ONLINE' }),
    }).catch(() => {});
  } catch (e) {}

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', activateFridayFromWakeWord, { once: true });
  } else {
    activateFridayFromWakeWord();
  }
});

ipcRenderer.on('friday:go-offline', () => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sleepFriday, { once: true });
  } else {
    sleepFriday();
  }
});

