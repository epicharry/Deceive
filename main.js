const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { startProxy, DeceiveProxy } = require('./proxy');

let mainWindow = null;
let tray = null;
let proxy = null;

// --- Configuration ---
const PROXY_CONFIG = {
  chatHost: process.env.RIOT_CHAT_HOST || 'ap.chat.si.riotgames.com',
  chatPort: parseInt(process.env.RIOT_CHAT_PORT || '5223', 10),
  chatProxyPort: 5223,
  configProxyPort: 0, // auto-assign
  status: 'offline',
  // Provide TLS cert/key for the MITM proxy if available
  // These should be PEM-encoded strings or file paths loaded at startup
  tlsCert: process.env.DECEIVE_TLS_CERT || null,
  tlsKey: process.env.DECEIVE_TLS_KEY || null,
};

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 300,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.hide();
  });
}

function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray || !proxy) return;

  const contextMenu = Menu.buildFromTemplate([
    { label: `Deceive - ${proxy.enabled ? 'Active' : 'Disabled'}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Enabled',
      type: 'checkbox',
      checked: proxy.enabled,
      click: () => {
        proxy.setEnabled(!proxy.enabled);
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Offline',
      type: 'radio',
      checked: proxy.status === 'offline',
      click: () => {
        proxy.setStatus('offline');
        updateTrayMenu();
      },
    },
    {
      label: 'Mobile',
      type: 'radio',
      checked: proxy.status === 'mobile',
      click: () => {
        proxy.setStatus('mobile');
        updateTrayMenu();
      },
    },
    {
      label: 'Online',
      type: 'radio',
      checked: proxy.status === 'chat',
      click: () => {
        proxy.setStatus('chat');
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        if (proxy) proxy.stop();
        app.exit(0);
      },
    },
  ]);

  tray.setToolTip('Deceive - Appear Offline');
  tray.setContextMenu(contextMenu);
}

async function initialize() {
  try {
    proxy = await startProxy(PROXY_CONFIG);
    console.log('[Main] Proxy started successfully');
    console.log(`[Main] Launch Riot Client with: --client-config-url="http://127.0.0.1:${proxy.configProxyPort}"`);
    createTray();
    updateTrayMenu();
  } catch (err) {
    console.error('[Main] Failed to start proxy:', err);
    app.quit();
  }
}

app.whenReady().then(async () => {
  await initialize();
  await createWindow();
});

app.on('window-all-closed', (e) => {
  // Keep running in tray
});

app.on('before-quit', () => {
  if (proxy) proxy.stop();
});

module.exports = { getProxy: () => proxy };
