/* ===========================================================================
 * FRIDAY — Electron main process
 * ========================================================================= */

'use strict';

const { app, BrowserWindow, Menu, shell, dialog, session, desktopCapturer, Tray, nativeImage, ipcMain, screen } = require('electron');
app.setName('FRIDAY');
const path = require('path');
const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');

// --- Constants -------------------------------------------------------------
const SERVER_PORT = 3000;
const SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 40_000;

const APP_ROOT = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {import('child_process').ChildProcess | null} */
let wakeWordProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
/** @type {import('electron').Tray | null} */
let tray = null;
let isQuitting = false;
let isBackendReady = false;

// ---------------------------------------------------------------------------
// Process cleanup helpers
// ---------------------------------------------------------------------------
function killPidTreeSync(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /F`, { stdio: 'ignore', timeout: 3000 });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    /* best-effort */
  }
}

function cleanupStalePorts(ports) {
  if (process.platform !== 'win32') return;
  for (const port of ports) {
    try {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      const lines = out.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[1].endsWith(`:${port}`) && parts[3] === 'LISTENING') {
          const pid = parseInt(parts[4], 10);
          if (pid && pid !== process.pid) {
            console.log(`[Startup] Freeing stale port ${port} held by PID ${pid}`);
            killPidTreeSync(pid);
          }
        }
      }
    } catch {
      /* no process listening */
    }
  }
}

// ---------------------------------------------------------------------------
// Single-instance guard
// ---------------------------------------------------------------------------
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    // Restore and focus UI
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (isBackendReady) {
        createMainWindow();
      }
    } else {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.setAlwaysOnTop(true);
      mainWindow.setAlwaysOnTop(false);
    }
  });
  app.whenReady().then(bootstrap);
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
/** @type {import('child_process').ChildProcess | null} */
let backupProcess = null;

function startBackupDaemon(dataDir) {
  const appRoot = APP_ROOT;
  const projectRoot = path.resolve(appRoot, '..', '..');
  const backupScript = path.join(projectRoot, 'data', 'memory_backup.cjs');
  if (!fs.existsSync(backupScript)) {
    console.warn('[Backup] memory_backup.cjs not found at', backupScript, '- backups disabled.');
    return null;
  }
  const backupDir = path.join(projectRoot, 'data', 'memories');
  const child = spawn(process.execPath, [backupScript, '--source', path.join(dataDir, 'memories.json'), '--backup-dir', backupDir, '--port', '3030'], {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FRIDAY_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logDir = path.join(APP_ROOT, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, 'memory_backup.log'), { flags: 'a' });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);
  child.on('exit', (code, signal) => {
    if (isQuitting) return;
    const now = Date.now();
    if (now - backupDaemonCrashWindowStart > BACKUP_DAEMON_WINDOW_MS) {
      backupDaemonCrashWindowStart = now;
      backupDaemonCrashCount = 0;
    }
    backupDaemonCrashCount += 1;
    if (backupDaemonCrashCount > BACKUP_DAEMON_MAX_CRASHES) {
      console.warn(
        `[Backup] memory_backup daemon crashed ${backupDaemonCrashCount} times in ` +
        `${Math.round(BACKUP_DAEMON_WINDOW_MS / 1000)}s; giving up auto-restart.`,
      );
      return;
    }
    console.warn(`[Backup] memory_backup daemon exited (code=${code}, signal=${signal}); restarting in 3s.`);
    setTimeout(() => startBackupDaemon(dataDir), 3000);
  });
  backupProcess = child;
  console.log('[Backup] memory_backup daemon started on http://127.0.0.1:3030');
  return child;
}

function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
    );
  }

  const dataDir = app.getPath('userData');
  startBackupDaemon(dataDir);

  const agentExe = app.isPackaged
    ? (fs.existsSync(path.join(process.resourcesPath, 'agent', 'friday-agent.exe'))
        ? path.join(process.resourcesPath, 'agent', 'friday-agent.exe')
        : path.join(process.resourcesPath, 'agent', 'friday-agent.exe'))
    : path.join(APP_ROOT, 'agent_dist', 'friday-agent', 'friday-agent.exe');

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    FRIDAY_LAUNCHED_BY: 'electron',
    FRIDAY_DATA_DIR: dataDir,
    FRIDAY_APP_ROOT: APP_ROOT,
  };
  if (fs.existsSync(agentExe)) {
    env.FRIDAY_AGENT_EXE = agentExe;
  }

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });

  serverProcess.on('message', (msg) => {
    if (msg && (msg.type === 'desktop_notify' || msg.type === 'show-dynamic-island')) {
      showDynamicIslandOnDesktop(msg.data || msg.payload || msg);
    } else if (msg && (msg.type === 'restart_app' || msg.type === 'restart')) {
      console.log('[Electron] 🔄 Restarting FRIDAY Desktop application via backend request...');
      isQuitting = true;
      cleanupAllProcessesSync();
      app.relaunch();
      app.exit(0);
    }
  });

  const logDir = path.join(APP_ROOT, 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logStream = fs.createWriteStream(path.join(logDir, 'backend_spawn.log'), { flags: 'a' });
  serverProcess.stdout?.pipe(logStream);
  serverProcess.stderr?.pipe(logStream);

  serverProcess.on('exit', (code, signal) => {
    if (!isQuitting) {
      dialog.showErrorBox(
        'FRIDAY backend stopped',
        `The FRIDAY backend process exited unexpectedly (code ${code}, signal ${signal}).`,
      );
      app.exit(1);
    }
  });
}

function stopBackend() {
  if (serverProcess) {
    const pid = serverProcess.pid;
    try { serverProcess.removeAllListeners(); } catch {}
    killPidTreeSync(pid);
    serverProcess = null;
  }
}

function stopBackupDaemon() {
  if (backupProcess) {
    const pid = backupProcess.pid;
    try { backupProcess.removeAllListeners(); } catch {}
    killPidTreeSync(pid);
    backupProcess = null;
  }
}

let backupDaemonCrashCount = 0;
let backupDaemonCrashWindowStart = Date.now();
const BACKUP_DAEMON_MAX_CRASHES = 3;
const BACKUP_DAEMON_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// Wake word lifecycle
// ---------------------------------------------------------------------------
let wakeWordFailCount = 0;

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const isVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible() && !mainWindow.isMinimized();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: isVisible ? 'FRIDAY (Online / On Screen)' : 'FRIDAY (Offline / Minimized to Tray)',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Open FRIDAY / Come Online',
      click: () => {
        showAndFocusMainWindow(true);
      },
    },
    {
      label: 'Go Offline (Minimize to Tray)',
      click: () => {
        hideMainWindowToTray();
      },
    },
    { type: 'separator' },
    {
      label: '🔄 Restart FRIDAY Desktop',
      click: () => {
        console.log('[Tray] 🔄 Restarting FRIDAY Desktop application...');
        isQuitting = true;
        cleanupAllProcessesSync();
        app.relaunch();
        app.exit(0);
      },
    },
    {
      label: 'Exit FRIDAY',
      click: () => {
        isQuitting = true;
        cleanupAllProcessesSync();
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;

  const iconPath = path.join(APP_ROOT, 'assets', 'tray-icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('FRIDAY — Desktop Voice AI');

  updateTrayMenu();

  tray.on('click', () => {
    showAndFocusMainWindow(true);
  });

  tray.on('double-click', () => {
    showAndFocusMainWindow(true);
  });
}

function showAndFocusMainWindow(bringOnline = true) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (isBackendReady) {
      createMainWindow();
    }
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.setAlwaysOnTop(true);
    mainWindow.setAlwaysOnTop(false);
  }
  updateTrayMenu();
  if (bringOnline && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('friday:come-online');
    mainWindow.webContents.send('friday:wake-word');
  }
}

function hideMainWindowToTray() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  updateTrayMenu();
}

function startWakeWordListener() {
  if (wakeWordProcess || process.platform !== 'win32' || wakeWordFailCount >= 3) return;

  const wakeScript = [
    'Add-Type -AssemblyName System.Speech',
    '$recognizer = $null',
    'try { $recognizer = New-Object -TypeName System.Speech.Recognition.SpeechRecognitionEngine -ArgumentList "en-US" } catch { try { $recognizer = New-Object -TypeName System.Speech.Recognition.SpeechRecognitionEngine } catch {} }',
    'if (-not $recognizer) { [Console]::Error.WriteLine("NO_RECOGNIZER"); exit 1 }',
    '$choices = New-Object System.Speech.Recognition.Choices',
    "[void]$choices.Add('hey friday')",
    "[void]$choices.Add('hey fridays')",
    "[void]$choices.Add('hey friday''s')",
    "[void]$choices.Add('friday come online buddy')",
    "[void]$choices.Add('friday come online')",
    "[void]$choices.Add('hey friday come online buddy')",
    "[void]$choices.Add('hey friday come online')",
    "[void]$choices.Add('come online buddy')",
    "[void]$choices.Add('come online friday')",
    "[void]$choices.Add('come online')",
    "[void]$choices.Add('wake up friday')",
    "[void]$choices.Add('friday wake up')",
    "[void]$choices.Add('awake friday')",
    "[void]$choices.Add('friday')",
    '$builder = New-Object System.Speech.Recognition.GrammarBuilder',
    '[void]$builder.Append($choices)',
    '$recognizer.LoadGrammar((New-Object System.Speech.Recognition.Grammar $builder))',
    '$recognizer.SetInputToDefaultAudioDevice()',
    '$script:lastMeter = [DateTime]::MinValue',
    '$recognizer.add_AudioLevelUpdated({ param($sender, $event) if ($event.AudioLevel -gt 4 -and (([DateTime]::UtcNow - $script:lastMeter).TotalSeconds -ge 2)) { $script:lastMeter = [DateTime]::UtcNow; [Console]::Out.WriteLine((\'AUDIO|\' + $event.AudioLevel)) } })',
    '$recognizer.add_SpeechRecognized({ param($sender, $event) $text = $event.Result.Text; $confidence = $event.Result.Confidence; [Console]::Out.WriteLine((\'HEARD|\' + $text + \'|\' + $confidence)); if ($confidence -ge 0.45) { [Console]::Out.WriteLine(\'WAKE\') } })',
    '$recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)',
    'while ($true) { Start-Sleep -Seconds 1 }',
  ].join('; ');

  try {
    wakeWordProcess = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-Command', wakeScript,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    wakeWordProcess.stdout?.on('data', (chunk) => {
      const output = chunk.toString();
      if (output.includes('HEARD|')) {
        console.log('[Wake word]', output.trim());
      }
      if (output.includes('AUDIO|')) {
        console.log('[Wake word] Microphone activity:', output.trim());
      }
      if (output.includes('WAKE')) {
        console.log('[Wake word] Activated FRIDAY via voice recognition.');
        showAndFocusMainWindow(true);
      }
    });
    wakeWordProcess.stderr?.on('data', (chunk) => {
      const msg = chunk.toString();
      if (msg.includes('NO_RECOGNIZER')) {
        wakeWordFailCount = 99;
      }
      console.warn('[Wake word] Windows recognition error:', msg);
    });
    wakeWordProcess.on('exit', (code) => {
      wakeWordProcess = null;
      if (code !== 0) wakeWordFailCount++;
      if (!isQuitting && wakeWordFailCount < 3) setTimeout(startWakeWordListener, 2000);
    });
  } catch (error) {
    console.warn('[Wake word] Could not start Windows recognition:', error);
    wakeWordProcess = null;
  }
}

function stopWakeWordListener() {
  if (wakeWordProcess) {
    const pid = wakeWordProcess.pid;
    try { wakeWordProcess.removeAllListeners(); } catch {}
    killPidTreeSync(pid);
    wakeWordProcess = null;
  }
}

function cleanupAllProcessesSync() {
  destroyScreenGlowWindows();
  if (tray && !tray.isDestroyed()) {
    try { tray.destroy(); } catch {}
    tray = null;
  }
  stopWakeWordListener();
  stopBackupDaemon();
  stopBackend();
}

/** Poll the backend until it answers, or reject on timeout. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(SERVER_ORIGIN, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Backend did not become ready in time.'));
        } else {
          setTimeout(tryOnce, 400);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Screen Glow Overlay Windows (Gemini Live Glowing Blue Perimeter)
// ---------------------------------------------------------------------------
/** @type {BrowserWindow[]} */
let screenGlowWindows = [];
let currentGlowState = 'hide';
let glowFlashTimeout = null;

function createScreenGlowWindows() {
  destroyScreenGlowWindows();
  try {
    const displays = screen.getAllDisplays();
    const glowHtmlPath = path.join(__dirname, 'screen_glow.html');

    for (const display of displays) {
      const { x, y, width, height } = display.bounds;
      const win = new BrowserWindow({
        x,
        y,
        width,
        height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        enableLargerThanScreen: true,
        backgroundColor: '#00000000',
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'overlay_preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
        },
      });

      win.setIgnoreMouseEvents(true, { forward: true });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

      win.loadFile(glowHtmlPath);

      win.webContents.on('did-finish-load', () => {
        if (currentGlowState !== 'hide' && currentGlowState !== 'inactive') {
          win.showInactive();
          win.setAlwaysOnTop(true, 'screen-saver');
          win.webContents.executeJavaScript(`window.setGlowState && window.setGlowState(${JSON.stringify(currentGlowState)});`).catch(() => {});
        }
      });

      win.on('closed', () => {
        screenGlowWindows = screenGlowWindows.filter((w) => w !== win);
      });

      screenGlowWindows.push(win);
    }
  } catch (err) {
    console.error('[Electron] Error creating screen glow windows:', err);
  }
}

function destroyScreenGlowWindows() {
  for (const win of screenGlowWindows) {
    try {
      if (!win.isDestroyed()) {
        win.destroy();
      }
    } catch {}
  }
  screenGlowWindows = [];
}

function showDynamicIslandOnDesktop(notifData) {
  if (screenGlowWindows.length === 0) {
    createScreenGlowWindows();
  }

  for (const win of screenGlowWindows) {
    try {
      if (!win.isDestroyed()) {
        win.showInactive();
        win.setAlwaysOnTop(true, 'screen-saver');
        const notifJson = JSON.stringify(notifData || {});
        if (win.webContents.isLoading()) {
          win.webContents.once('did-finish-load', () => {
            win.webContents.executeJavaScript(`window.showDynamicIsland && window.showDynamicIsland(${notifJson});`).catch(() => {});
          });
        } else {
          win.webContents.executeJavaScript(`window.showDynamicIsland && window.showDynamicIsland(${notifJson});`).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[Electron] Error triggering Dynamic Island on desktop overlay:', e);
    }
  }
}

function setScreenGlowState(mode, options = {}) {
  currentGlowState = mode;
  if (glowFlashTimeout) {
    clearTimeout(glowFlashTimeout);
    glowFlashTimeout = null;
  }

  if (screenGlowWindows.length === 0 && mode !== 'hide' && mode !== 'inactive' && mode) {
    createScreenGlowWindows();
  }

  for (const win of screenGlowWindows) {
    try {
      if (!win.isDestroyed()) {
        if (mode === 'hide' || mode === 'inactive' || !mode) {
          win.webContents.executeJavaScript(`window.setGlowState && window.setGlowState('hide');`).catch(() => {});
          setTimeout(() => {
            try {
              if ((currentGlowState === 'hide' || currentGlowState === 'inactive') && !win.isDestroyed()) {
                win.hide();
              }
            } catch {}
          }, 450);
        } else {
          win.showInactive();
          win.setAlwaysOnTop(true, 'screen-saver');
          const optsJson = JSON.stringify(options);
          win.webContents.executeJavaScript(`window.setGlowState && window.setGlowState(${JSON.stringify(mode)}, ${optsJson});`).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[Electron] Error updating screen glow window:', e);
    }
  }

  if (mode === 'flash') {
    const duration = options.duration || 2600;
    glowFlashTimeout = setTimeout(() => {
      setScreenGlowState('hide');
    }, duration);
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 300,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => (splashWindow = null));
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    const currentUrl = mainWindow.webContents.getURL();
    if (!currentUrl || currentUrl === 'about:blank' || !currentUrl.startsWith(SERVER_ORIGIN)) {
      mainWindow.loadURL(SERVER_ORIGIN);
    }
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    frame: true,
    resizable: true,
    minimizable: true,
    maximizable: true,
    closable: true,
    show: true,
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'FRIDAY',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });

  Menu.setApplicationMenu(null);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  const rendererLogPath = path.join(APP_ROOT, 'logs', 'renderer.log');
  const logRenderer = (msg) => {
    try {
      fs.appendFileSync(rendererLogPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch {}
  };

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    logRenderer(`[Console L${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logRenderer(`[Renderer Process Gone] ${JSON.stringify(details)}`);
    if (!isQuitting && details.reason !== 'clean-exit') {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('[Electron] Reloading main window after renderer termination...');
          mainWindow.loadURL(SERVER_ORIGIN);
        }
      }, 1000);
    }
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    logRenderer(`[Failed Load ${errorCode}] ${errorDescription} at ${validatedURL}`);
    if (errorCode === -3) return;
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(SERVER_ORIGIN);
      }
    }, 1200);
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close();
      splashWindow = null;
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    updateTrayMenu();
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      hideMainWindowToTray();
    }
  });

  mainWindow.on('show', () => updateTrayMenu());
  mainWindow.on('hide', () => updateTrayMenu());
  mainWindow.on('minimize', () => updateTrayMenu());
  mainWindow.on('restore', () => updateTrayMenu());

  mainWindow.on('closed', () => {
    mainWindow = null;
    updateTrayMenu();
  });

  mainWindow.loadURL(SERVER_ORIGIN);
}

function setupMediaCapturer() {
  try {
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(true);
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return true;
    });
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
        if (sources.length > 0) {
          callback({ video: sources[0] });
        } else {
          callback({});
        }
      }).catch((err) => {
        console.error('[Electron] desktopCapturer error:', err);
        callback({});
      });
    });
  } catch (e) {
    console.warn('[Electron] Could not setup display media handler:', e);
  }
}

async function bootstrap() {
  app.setAppUserModelId('com.friday.desktop');
  setupMediaCapturer();
  startWakeWordListener();
  createSplashWindow();
  createTray();

  try {
    screen.on('display-metrics-changed', () => {
      if (currentGlowState !== 'hide' && currentGlowState !== 'inactive') {
        createScreenGlowWindows();
      }
    });
    screen.on('display-added', () => {
      if (currentGlowState !== 'hide' && currentGlowState !== 'inactive') {
        createScreenGlowWindows();
      }
    });
    screen.on('display-removed', () => {
      if (currentGlowState !== 'hide' && currentGlowState !== 'inactive') {
        createScreenGlowWindows();
      }
    });
  } catch (e) {}

  try {
    cleanupStalePorts([SERVER_PORT, 3030]);
    startBackend();
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    isBackendReady = true;
    createMainWindow();
    createScreenGlowWindows();
  } catch (err) {
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
    dialog.showErrorBox(
      'FRIDAY failed to start',
      `${err instanceof Error ? err.message : String(err)}`,
    );
    cleanupAllProcessesSync();
    app.exit(1);
  }
}

// ---------------------------------------------------------------------------
// IPC Handlers
// ---------------------------------------------------------------------------
ipcMain.on('friday:hide-to-tray', () => {
  hideMainWindowToTray();
});

ipcMain.on('friday:show-window', (_event, bringOnline = true) => {
  showAndFocusMainWindow(bringOnline);
});

ipcMain.on('friday:go-offline', () => {
  hideMainWindowToTray();
});

ipcMain.on('friday:come-online', () => {
  showAndFocusMainWindow(true);
});

ipcMain.on('friday:screen-glow-show', (_event, mode = 'active', options = {}) => {
  setScreenGlowState(mode, options);
});

ipcMain.on('friday:screen-glow-hide', () => {
  setScreenGlowState('hide');
});

ipcMain.on('friday:screen-glow-flash', (_event, durationMs = 2600, options = {}) => {
  setScreenGlowState('flash', { ...options, duration: durationMs });
});

ipcMain.on('friday:screen-glow-pause', () => {
  setScreenGlowState('paused');
});

ipcMain.on('friday:show-dynamic-island', (_event, notifData) => {
  showDynamicIslandOnDesktop(notifData);
});

ipcMain.on('friday:overlay-mouse', (_event, ignore) => {
  for (const win of screenGlowWindows) {
    try {
      if (!win.isDestroyed()) {
        win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
      }
    } catch {}
  }
});







let lastCallActionTimestamp = 0;

ipcMain.on('friday:call-action', (_event, actionData) => {
  const now = Date.now();
  if (now - lastCallActionTimestamp < 4000) {
    console.log('[Electron Call Action] ⏳ Ignored duplicate call action within 4s window.');
    return;
  }
  lastCallActionTimestamp = now;

  const action = actionData?.action; // 'receive' | 'decline'
  if (action === 'receive') {
    openRealDiscordApp();
  }
  const caller = actionData?.caller || actionData?.from || actionData?.author || 'Ladybug';
  const channel = actionData?.channel || actionData?.channelId || 'friday-chat';
  const callerLower = caller.toLowerCase();
  const isLadybug = callerLower.includes('ladybug') || callerLower.includes('sohana') || callerLower.includes('bheri');

  let text = '';
  if (action === 'receive') {
    text = isLadybug
      ? `🟢 **Call Received!**\nSam call ta receive koreche, ashche Ladybug! 🐞✨`
      : `🟢 **Call Received!**\nSam has received the call and is coming! 📞✨`;
  } else if (action === 'decline' || action === 'reject' || action === 'busy') {
    text = isLadybug
      ? `🔴 **Call Declined**\nSam ekhon ektu busy ache ba call ta cut koreche, Ladybug! Ektu por abar kotha bolo ✨`
      : `🔴 **Call Declined**\nSam is currently busy and couldn't take the call right now.`;
  }

  if (text) {
    console.log(`[Electron Call Action] 📞 Dispatched call action "${action}" to Discord for ${caller}: "${text.replace(/\n/g, ' ')}"`);
    let sentViaServer = false;
    if (serverProcess && typeof serverProcess.send === 'function') {
      try {
        serverProcess.send({
          type: 'discord_send',
          channel,
          message: text
        });
        sentViaServer = true;
      } catch (e) {
        sentViaServer = false;
      }
    }

    // Direct HTTP fallback ONLY if serverProcess is not available
    if (!sentViaServer) {
      try {
        const secretsCandidates = [
          path.join(APP_ROOT, 'secrets.json'),
          path.join(process.cwd(), 'secrets.json'),
          path.join(__dirname, '..', 'secrets.json')
        ];
        let renderUrl = '';
        for (const p of secretsCandidates) {
          if (fs.existsSync(p)) {
            const sec = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (sec.discordRenderUrl) renderUrl = sec.discordRenderUrl;
          }
        }
        fetch(`${renderUrl}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: channel, channelName: channel, message: text })
        }).catch(() => {});
      } catch {}
    }
  }
});

ipcMain.on('friday:show-notification', (_event, title, body, options = {}) => {
  const { Notification } = require('electron');
  if (Notification && Notification.isSupported()) {
    try {
      const notif = new Notification({
        title: title || 'FRIDAY Remote Notification',
        body: body || '',
        silent: false,
        ...options
      });
      notif.show();
    } catch {}
  }
});

ipcMain.on('friday:restart-app', () => {
  console.log('[Electron] 🔄 Restarting FRIDAY Desktop application via renderer IPC...');
  isQuitting = true;
  cleanupAllProcessesSync();
  app.relaunch();
  app.exit(0);
});

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && isBackendReady) createMainWindow();
});

app.on('window-all-closed', () => {
  if (isQuitting) {
    cleanupAllProcessesSync();
    if (process.platform !== 'darwin') {
      app.exit(0);
    }
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  cleanupAllProcessesSync();
});

app.on('will-quit', () => {
  cleanupAllProcessesSync();
});

process.on('exit', () => {
  cleanupAllProcessesSync();
});
