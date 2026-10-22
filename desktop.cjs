const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
const path = require('node:path');
const version = require('./package.json').version;
const smoke = process.env.TRAE_SWITCH_SMOKE_TEST === '1';
app.setName('Trae Switch');
app.setPath(
  'userData',
  smoke ? process.env.TRAE_SWITCH_SMOKE_PROFILE : path.join(app.getPath('appData'), 'Trae Switch'),
);
if (smoke) app.commandLine.appendSwitch('disable-gpu');
let service, window;

async function boot() {
  const { start } = await import('./server/index.mjs');
  let url;
  try {
    service = await start(smoke ? 0 : 19827);
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
    show: !smoke,
    width: 1440,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    title: 'Trae Switch',
    icon,
    backgroundColor: '#f7f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
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
  const { AppUpdater } = await import('./server/updater.mjs');
  const { prepareUpdate, confirmUpdateBoot, previousUpdateFailure } =
    await import('./server/update-install.mjs');
  const updatesDirectory = path.join(service?.store.dir || app.getPath('userData'), 'updates');
  const updater = new AppUpdater({
    directory: updatesDirectory,
    onChange: (value) => {
      if (!win.isDestroyed()) win.webContents.send('app-update-state', value);
    },
    installer:
      app.isPackaged && !smoke && service
        ? async (ready) => {
            const prepared = await prepareUpdate(ready, {
              directory: updatesDirectory,
              packaged: app.isPackaged,
            });
            try {
              await service.close();
            } catch {
              try {
                process.kill(prepared.helperPid);
              } catch {}
              throw new Error('无法停止当前后台，更新已取消，请重新启动应用后重试');
            }
            service = null;
            setImmediate(() => app.quit());
          }
        : null,
  });
  updater.state.previousFailure = previousUpdateFailure(process.execPath, updatesDirectory);
  if (app.isPackaged && !smoke && !service)
    updater.state.installUnavailableReason =
      '当前连接了独立后台，请先退出独立后台，再重新打开桌面应用以安装更新';
  ipcMain.handle('app-update', async (event, action) => {
    if (
      event.sender !== win.webContents ||
      event.senderFrame !== win.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== url
    )
      throw new Error('更新操作来源无效');
    if (action === 'state') return updater.snapshot();
    if (!['check', 'download', 'cancel', 'install'].includes(action))
      throw new Error('未知更新操作');
    return updater[action]();
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Trae Switch',
        submenu: [
          { label: '关于 Trae Switch', click: () => win.loadURL(url + '/#about') },
          {
            label: '检查更新…',
            click: () => {
              win.loadURL(url + '/#about').then(() => updater.check());
            },
          },
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
  if (app.isPackaged && !smoke) {
    const timer = setTimeout(() => updater.check(), 3000);
    timer.unref();
  }
  confirmUpdateBoot(process.argv, process.execPath, version, updatesDirectory);
  if (smoke) {
    const ok = await win.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const deadline=Date.now()+8000;const check=()=>{if(document.querySelector('nav')&&document.querySelector('h1'))resolve(!document.querySelector('[data-page="sessions"]'));else if(Date.now()>deadline)reject(new Error('Renderer failed to load'));else setTimeout(check,50);};check();})`,
    );
    if (!ok) throw new Error('Hidden session entry unexpectedly visible');
    const chartLayout = await win.webContents.executeJavaScript(
      `(()=>{const svg=document.querySelector('.request-trend svg');return !!svg && !document.querySelector('.chart-bar') && document.documentElement.scrollWidth<=document.documentElement.clientWidth && svg.getBoundingClientRect().right<=svg.parentElement.getBoundingClientRect().right+1;})()`,
    );
    if (!chartLayout)
      throw new Error('Request chart is missing or overflows the packaged renderer');
    const bridge = await win.webContents.executeJavaScript(
      `window.desktopUpdates.state().then(s => ({ version: s.currentVersion, status: s.status }))`,
    );
    if (bridge.version !== version || bridge.status !== 'idle')
      throw new Error('Update preload bridge failed');
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-page="about"]').click()`,
    );
    updater.emit({ status: 'downloading', downloaded: 5, total: 10 });
    const progress = await win.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+3000;const check=()=>{const p=document.querySelector('.update-panel progress');if(p?.value===5 && document.querySelector('[data-action="cancel-update"]'))resolve(true);else if(Date.now()>end)reject(new Error('Update progress event failed'));else setTimeout(check,25)};check()})`,
    );
    updater.emit({ status: 'ready', downloaded: 10 });
    const ready = await win.webContents.executeJavaScript(
      `new Promise((resolve,reject)=>{const end=Date.now()+3000;const check=()=>{if(document.querySelector('[data-action="install-update"]'))resolve(true);else if(Date.now()>end)reject(new Error('Update ready event failed'));else setTimeout(check,25)};check()})`,
    );
    if (!progress || !ready) throw new Error('Update UI smoke test failed');
    await service.close();
    service = null;
    console.log('TRAE_DESKTOP_SMOKE_OK ' + version);
    app.quit();
  }
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
      if (smoke) {
        console.error(error);
        app.exit(1);
        return;
      }
      dialog.showErrorBox('Trae Switch 启动失败', error.message);
      app.quit();
    });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  service?.close();
});
