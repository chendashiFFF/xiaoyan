const { app, BrowserWindow, ipcMain, Menu, screen } = require('electron');
const path = require('node:path');

const BASE_SIZE = { width: 320, height: 380 };
const WINDOW_MARGIN = 24;
let petWindow;
let dragState = null;
let savedPosition = null;

function getPositionStore() {
  return path.join(app.getPath('userData'), 'pet-position.json');
}

function readSavedPosition() {
  try {
    return JSON.parse(require('node:fs').readFileSync(getPositionStore(), 'utf8'));
  } catch {
    return null;
  }
}

function savePosition() {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  try {
    require('node:fs').writeFileSync(getPositionStore(), JSON.stringify({ x: bounds.x, y: bounds.y }));
  } catch {
    // A missing user-data directory should never make the pet unusable.
  }
}

function clampToWorkArea(x, y, width = BASE_SIZE.width, height = BASE_SIZE.height) {
  const display = screen.getDisplayNearestPoint({ x, y });
  const area = display.workArea;
  return {
    x: Math.max(area.x + WINDOW_MARGIN, Math.min(x, area.x + area.width - width - WINDOW_MARGIN)),
    y: Math.max(area.y + WINDOW_MARGIN, Math.min(y, area.y + area.height - height - WINDOW_MARGIN)),
  };
}

function createPetWindow() {
  savedPosition = readSavedPosition();
  const initial = clampToWorkArea(
    savedPosition?.x ?? 80,
    savedPosition?.y ?? 80,
  );

  petWindow = new BrowserWindow({
    ...BASE_SIZE,
    x: initial.x,
    y: initial.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  petWindow.setAlwaysOnTop(true, 'floating');
  petWindow.setMenuBarVisibility(false);
  petWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  petWindow.once('ready-to-show', () => petWindow.showInactive());
  petWindow.on('moved', savePosition);
  petWindow.on('closed', () => { petWindow = null; });

  petWindow.webContents.on('context-menu', () => {
    const playItem = (label, action) => ({ label, click: () => petWindow?.webContents.send('pet:play', action) });
    const menu = Menu.buildFromTemplate([
      playItem('待机', 'idle'),
      playItem('挥手', 'wave'),
      playItem('施法', 'cast'),
      playItem('攻击', 'attack'),
      playItem('跑动', 'run'),
      playItem('跳跃', 'jump'),
      playItem('鞠躬', 'bow'),
      playItem('舞蹈', 'dance'),
      playItem('坐下', 'sit'),
      playItem('困倦', 'sleep'),
      playItem('转身', 'turn'),
      playItem('鼓掌', 'clap'),
      playItem('惊讶', 'surprise'),
      playItem('难过', 'sad'),
      { type: 'separator' },
      { label: '退出桌面宠物', click: () => app.quit() },
    ]);
    menu.popup({ window: petWindow });
  });
}

function moveWindow(x, y) {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  const safe = clampToWorkArea(x, y, bounds.width, bounds.height);
  petWindow.setPosition(Math.round(safe.x), Math.round(safe.y), false);
}

ipcMain.handle('window:get-state', () => ({
  bounds: petWindow?.getBounds() ?? null,
  display: petWindow ? screen.getDisplayMatching(petWindow.getBounds()).workArea : null,
}));

ipcMain.handle('window:move-relative', (_event, dx, dy = 0) => {
  if (!petWindow) return null;
  const bounds = petWindow.getBounds();
  moveWindow(bounds.x + Number(dx || 0), bounds.y + Number(dy || 0));
  return petWindow.getBounds();
});

ipcMain.handle('window:set-size', (_event, width, height) => {
  if (!petWindow) return null;
  const old = petWindow.getBounds();
  const nextWidth = Math.max(220, Math.round(Number(width) || BASE_SIZE.width));
  const nextHeight = Math.max(260, Math.round(Number(height) || BASE_SIZE.height));
  petWindow.setSize(nextWidth, nextHeight, false);
  const next = clampToWorkArea(old.x, old.y + old.height - nextHeight, nextWidth, nextHeight);
  petWindow.setPosition(next.x, next.y, false);
  savePosition();
  return petWindow.getBounds();
});

ipcMain.on('window:drag-start', (_event, point) => {
  if (!petWindow) return;
  const bounds = petWindow.getBounds();
  dragState = { start: point, window: { x: bounds.x, y: bounds.y } };
});

ipcMain.on('window:drag-move', (_event, point) => {
  if (!dragState) return;
  moveWindow(
    dragState.window.x + (Number(point?.x) - Number(dragState.start.x)),
    dragState.window.y + (Number(point?.y) - Number(dragState.start.y)),
  );
});

ipcMain.on('window:drag-end', () => {
  dragState = null;
  savePosition();
});

ipcMain.on('window:set-ignore-mouse-events', (_event, ignore) => {
  petWindow?.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});

app.whenReady().then(() => {
  createPetWindow();
  app.on('activate', () => {
    if (!petWindow) createPetWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', savePosition);
