/* ===========================================================================
 * FRIDAY — Desktop Overlay Preload (Dynamic Island & Screen Outline)
 * ========================================================================= */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronOverlay', {
  setIgnoreMouseEvents: (ignore) => {
    ipcRenderer.send('friday:overlay-mouse', ignore);
  },
  openFridayDiscord: () => {
    ipcRenderer.send('friday:open-discord-app');
  },
  openRealDiscord: () => {
    ipcRenderer.send('friday:open-discord-app');
  },
  showWindow: () => {
    ipcRenderer.send('friday:show-window', true);
  },
  sendCallAction: (action, callData) => {
    ipcRenderer.send('friday:call-action', { action, ...callData });
  }
});
