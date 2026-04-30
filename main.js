const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');
const { startProxy } = require('./proxy');

let mainWindow = null;
let tray = null;
let proxy = null;

// --- Configuration ---
const RIOT_CHAT_HOST = process.env.RIOT_CHAT_HOST || 'ap.chat.si.riotgames.com';
const RIOT_CHAT_PORT = parseInt(process.env.RIOT_CHAT_PORT || '5223', 10);
const CERT_URL = 'https://mln.cx/deceive/localhost.pfx';
const CERT_CACHE_PATH = path.join(app.getPath('userData'), 'localhost.pfx');
const RIOT_INSTALLS_PATH = path.join('C:', 'ProgramData', 'Riot Games', 'RiotClientInstalls.json');

// --- Certificate Management ---
function downloadCert() {
  return new Promise((resolve, reject) => {
    https.get(CERT_URL, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Certificate download failed: HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function getCertificate() {
  // Check cached cert
  if (fs.existsSync(CERT_CACHE_PATH)) {
    const stats = fs.statSync(CERT_CACHE_PATH);
    const ageMs = Date.now() - stats.mtimeMs;
    const twentyDaysMs = 20 * 24 * 60 * 60 * 1000;
    if (ageMs < twentyDaysMs) {
      console.log('[Main] Using cached certificate');
      return fs.readFileSync(CERT_CACHE_PATH);
    }
  }

  console.log('[Main] Downloading certificate from mln.cx...');
  const certBuffer = await downloadCert();
  fs.mkdirSync(path.dirname(CERT_CACHE_PATH), { recursive: true });
  fs.writeFileSync(CERT_CACHE_PATH, certBuffer);
  console.log('[Main] Certificate cached');
  return certBuffer;
}

// --- Riot Client Discovery ---
function findRiotClientPath() {
  if (!fs.existsSync(RIOT_INSTALLS_PATH)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(RIOT_INSTALLS_PATH, 'utf-8'));
    const candidates = [data.rc_default, data.rc_live, data.rc_beta].filter(Boolean);
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } catch (e) {
    console.error('[Main] Failed to read RiotClientInstalls.json:', e.message);
  }
  return null;
}

function killRiotProcesses() {
  const names = ['RiotClientServices', 'VALORANT-Win64-Shipping', 'LeagueClient', 'LoR'];
  for (const name of names) {
    try {
      require('child_process').execSync(`taskkill /F /IM ${name}.exe 2>nul`, { stdio: 'ignore' });
    } catch {
      // Process may not be running
    }
  }
}

function isRiotClientRunning() {
  try {
    const result = require('child_process').execSync(
      'tasklist /FI "IMAGENAME eq RiotClientServices.exe" /NH',
      { encoding: 'utf-8' }
    );
    return result.includes('RiotClientServices.exe');
  } catch {
    return false;
  }
}

function launchRiotClient(riotClientPath, configPort) {
  const args = [
    `--client-config-url=http://127.0.0.1:${configPort}`,
    '--launch-product=valorant',
    '--launch-patchline=live',
  ];

  console.log(`[Main] Launching Riot Client: ${riotClientPath}`);
  console.log(`[Main] Args: ${args.join(' ')}`);

  const child = spawn(riotClientPath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

// --- Electron UI ---
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 320,
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
      click: () => { proxy.setStatus('offline'); updateTrayMenu(); },
    },
    {
      label: 'Mobile',
      type: 'radio',
      checked: proxy.status === 'mobile',
      click: () => { proxy.setStatus('mobile'); updateTrayMenu(); },
    },
    {
      label: 'Online',
      type: 'radio',
      checked: proxy.status === 'chat',
      click: () => { proxy.setStatus('chat'); updateTrayMenu(); },
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

// --- Main Startup ---
async function initialize() {
  try {
    // Step 1: Find Riot Client
    const riotClientPath = findRiotClientPath();
    if (!riotClientPath) {
      dialog.showErrorBox('Deceive',
        'Could not find Riot Client installation.\n\n' +
        'Please launch Valorant normally at least once, then try again.\n\n' +
        `Expected config at: ${RIOT_INSTALLS_PATH}`
      );
      app.exit(1);
      return;
    }
    console.log(`[Main] Found Riot Client: ${riotClientPath}`);

    // Step 2: Kill existing Riot Client if running
    if (isRiotClientRunning()) {
      const result = await dialog.showMessageBox({
        type: 'question',
        buttons: ['Yes', 'No'],
        defaultId: 0,
        title: 'Deceive',
        message: 'Riot Client is already running. Deceive needs to restart it with the proxy configuration.\n\nKill existing Riot Client processes?',
      });

      if (result.response === 0) {
        killRiotProcesses();
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        app.exit(0);
        return;
      }
    }

    // Step 3: Get TLS certificate
    const pfxBuffer = await getCertificate();

    // Step 4: Start proxy
    proxy = await startProxy({
      chatHost: RIOT_CHAT_HOST,
      chatPort: RIOT_CHAT_PORT,
      chatProxyPort: 0, // auto-assign
      configProxyPort: 0,
      status: 'offline',
      pfxBuffer,
    });

    console.log(`[Main] Config proxy: http://127.0.0.1:${proxy.configProxyPort}`);
    console.log(`[Main] Chat proxy: port ${proxy.chatProxyPort}`);

    // Step 5: Launch Riot Client with config proxy
    launchRiotClient(riotClientPath, proxy.configProxyPort);

    // Step 6: UI
    createTray();
    updateTrayMenu();
    console.log('[Main] Deceive is active - appearing offline');
  } catch (err) {
    console.error('[Main] Startup error:', err);
    dialog.showErrorBox('Deceive Error', `Failed to initialize:\n\n${err.message}`);
    app.exit(1);
  }
}

app.whenReady().then(async () => {
  await initialize();
  await createWindow();
});

app.on('window-all-closed', () => {
  // Keep running in tray
});

app.on('before-quit', () => {
  if (proxy) proxy.stop();
});
