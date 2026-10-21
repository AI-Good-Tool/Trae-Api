const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('node:path');
const version = require('./package.json').version;
app.setName('Trae Switch');
app.setPath('userData', path.join(app.getPath('appData'), 'Trae Switch'));
let service, window;

async function boot() {
  const { start } = await import('./server/index.mjs');
  let url;
  try {
    service = await start(19827);
    url = service.url;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    const response = await fetch('http://127.0.0.1:19827', { signal: AbortSignal.timeout(3000) });
    if (response.headers.get('x-trae-switch') !== version) {
      throw new Error('19827 端口被其他程序或旧版 Trae Switch 占用，请先退出旧版再打开。');
    }
    url = 'http://127.0.0.1:19827';
  }
  const icon = path.join(__dirname, 'ui', 'icon.png');
  if (process.platform === 'darwin') app.dock.setIcon(icon);
  const win = (window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: 'Trae Switch',
    icon,
    backgroundColor: '#f7f8fa',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  }));
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('https://')) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== url) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(
      webContents.getURL().startsWith(url + '/') && permission === 'clipboard-sanitized-write',
    );
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Trae Switch',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  await win.loadURL(url);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(boot)
    .catch((error) => {
      dialog.showErrorBox('Trae Switch 启动失败', error.message);
      app.quit();
    });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  service?.close();
});
