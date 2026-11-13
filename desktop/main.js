'use strict';
// antics for Windows: TENDHA2's antics site (GitHub Pages) in its own window. It loads the live site, so every
// update to the site is in the app at once; the app itself only adds the window, the menu, saving files and
// the safety rules below.

const path = require('path');
const {
  app, BrowserWindow, Menu, Notification, clipboard, dialog, screen, session, shell,
} = require('electron');
const policy = require('./lib/policy');
const windowState = require('./lib/window-state');

const APP_ID = 'com.tendha2.antics';
const PARTITION = 'persist:antics'; // kept on disk, so the connection to the worker stays between starts
const SITE = policy.makeSite(policy.siteUrl());
const OFFLINE_PAGE = path.join(__dirname, 'offline.html');
const ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const ICON_PNG = path.join(__dirname, 'assets', 'icon.png');
const PAPER = '#fff3dc'; // the site's background, so the window never flashes white

let win = null; // the main window
let state = null; // its remembered size, place and zoom
let saveState = () => {};
let failures = 0; // failed loads in a row, shown on the offline screen
const lastSite = new WeakMap(); // webContents -> the last page of the site it showed (what Retry loads)
const appPages = new WeakMap(); // webContents of antics' own windows -> 'main' or 'child' (not DevTools)

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const mainWindow = () => (win && !win.isDestroyed() ? win : null);
const activeWindow = () => BrowserWindow.getFocusedWindow() || mainWindow();

function webPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    partition: PARTITION,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: true,
    additionalArguments: [`--antics-version=${app.getVersion()}`],
  };
}

// ---------- Loading the site, and the screen for when it can't load ----------

function loadSite(url, contents = mainWindow() && mainWindow().webContents) {
  if (!contents || contents.isDestroyed()) return;
  lastSite.set(contents, url);
  contents.loadURL(url).catch(() => {}); // a failure is handled by did-fail-load (the offline screen)
}

function showProblem(contents, { url, reason, code = '', desc = '', to = '' }) {
  if (contents.isDestroyed()) return;
  failures += 1;
  const query = { url: url || lastSite.get(contents) || SITE.url, reason, code: String(code), desc, tries: String(failures), to };
  contents.loadFile(OFFLINE_PAGE, { query }).catch(() => {});
}

// Reload always ends on the site: from the problem screen, an empty window or anything else off the site, it loads
// the site's last page again (or its start page) instead of reloading what is there.
function reload(contents, hard = false) {
  if (!contents || contents.isDestroyed()) return;
  if (policy.classify(contents.getURL(), SITE) !== 'site') loadSite(lastSite.get(contents) || SITE.url, contents);
  else if (hard) contents.reloadIgnoringCache();
  else contents.reload();
}

// Back and Forward (the mouse's side buttons, Alt+Left / Alt+Right, the View menu): only to pages of the site (the
// site's tabs are steps in its history: ?tab=videos, ?tab=make, ...).
function historyStep(contents, dir) {
  if (!contents || contents.isDestroyed()) return false;
  const nav = contents.navigationHistory;
  const can = dir < 0 ? nav.canGoBack() : nav.canGoForward();
  if (!can) return false;
  const target = nav.getEntryAtIndex(nav.getActiveIndex() + dir);
  if (!target || policy.classify(target.url, SITE) !== 'site') return false;
  if (dir < 0) nav.goBack();
  else nav.goForward();
  return true;
}

// ---------- What a page may open ----------

function openExternal(url) {
  // Only web pages and mail links ever reach the default browser (policy.classify decides).
  shell.openExternal(url).catch(() => {});
}

function act(contents, kind, url) {
  if (kind === 'download') contents.downloadURL(url);
  else if (kind === 'external') openExternal(url);
  // 'block': nothing happens
}

function onNavigate(event, contents) {
  const kind = policy.classify(event.url, SITE);
  if (kind === 'site') return;
  event.preventDefault();
  act(contents, kind, event.url);
}

// A page of the site that answers with a redirect to another address: the site has moved (a custom domain on GitHub
// Pages, a renamed account or repo). The window says so (with the new address) instead of going blank while the
// browser opens it silently: the address is built into this app, so it needs a new app (or the browser) then.
function onRedirect(event, contents) {
  if (!event.isMainFrame) return;
  const kind = policy.classify(event.url, SITE);
  if (kind === 'site') return;
  event.preventDefault();
  if (kind === 'download') { // (a file of the worker's: saved, as always)
    act(contents, kind, event.url);
    return;
  }
  const from = lastSite.get(contents) || SITE.url;
  // Next turn: Chromium first finishes cancelling this load.
  setTimeout(() => showProblem(contents, { url: from, reason: 'moved', to: kind === 'external' ? event.url : '' }), 0);
}

// Every page that commits in an antics window must be the site or the problem screen. about:blank gets past
// will-navigate (Electron sends none for it), and a frame from another site could then write its own page into a
// window titled "antics": the main window goes back to the site, a second window (opened by the site) closes.
function onCommitted(contents, url) {
  const role = appPages.get(contents);
  if (!role || policy.classify(url, SITE) === 'site' || url.startsWith('file:')) return;
  if (role === 'child') {
    const w = BrowserWindow.fromWebContents(contents);
    if (w && !w.isDestroyed()) w.destroy();
    return;
  }
  loadSite(lastSite.get(contents) || SITE.url, contents);
}

function onWindowOpen(contents, { url }) {
  const kind = policy.classify(url, SITE);
  if (kind === 'site') {
    // A page of the site that asks for a new tab (e.g. the PC setup guide) gets its own antics window.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        title: 'antics', icon: ICON, backgroundColor: PAPER, width: 1000, height: 800, webPreferences: webPreferences(),
      },
    };
  }
  act(contents, kind, url);
  return { action: 'deny' };
}

// ---------- Zoom ----------

function zoom(contents, step) {
  if (!contents || contents.isDestroyed()) return;
  const level = step === 0 ? 0 : Math.min(Math.max(contents.getZoomLevel() + step, -3), 5);
  contents.setZoomLevel(level);
  const main = mainWindow();
  if (state && main && contents === main.webContents) {
    state.zoom = level;
    windowState.save(stateFile(), state);
  }
}

// ---------- Right-click menu (copy, paste, save a video) ----------

function contextMenu(contents, p) {
  const items = [];
  const sep = () => items.length && items[items.length - 1].type !== 'separator' && items.push({ type: 'separator' });
  if (p.isEditable) {
    for (const word of (p.dictionarySuggestions || []).slice(0, 4)) {
      items.push({ label: word, click: () => contents.replaceMisspelling(word) });
    }
    sep();
    const f = p.editFlags;
    items.push(
      { role: 'undo', enabled: f.canUndo }, { role: 'redo', enabled: f.canRedo }, { type: 'separator' },
      { role: 'cut', enabled: f.canCut }, { role: 'copy', enabled: f.canCopy }, { role: 'paste', enabled: f.canPaste },
      { type: 'separator' }, { role: 'selectAll', enabled: f.canSelectAll },
    );
  } else if (p.selectionText && p.selectionText.trim()) {
    items.push({ role: 'copy' });
  }
  if (p.linkURL && /^(https?|mailto):/i.test(p.linkURL)) {
    sep();
    items.push({ label: 'Copy link', click: () => clipboard.writeText(p.linkURL).catch(() => {}) });
  }
  const media = { video: 'video', image: 'picture', audio: 'sound' }[p.mediaType];
  if (media && /^(https?|blob):/i.test(p.srcURL || '')) {
    sep();
    items.push({ label: `Save ${media} as…`, click: () => contents.downloadURL(p.srcURL) });
  }
  if (!items.length) return;
  const owner = BrowserWindow.fromWebContents(contents) || undefined;
  Menu.buildFromTemplate(items).popup({ window: owner });
}

// ---------- The rules every page in the app runs under ----------

function guard(contents) {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('will-navigate', (e) => onNavigate(e, contents));
  contents.on('will-redirect', (e) => onRedirect(e, contents));
  contents.setWindowOpenHandler((details) => onWindowOpen(contents, details));
  contents.on('did-create-window', (child) => {
    appPages.set(child.webContents, 'child');
    child.on('page-title-updated', (e) => e.preventDefault());
    child.on('app-command', (e, cmd) => onAppCommand(child.webContents, cmd));
  });

  contents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    // -3 (ERR_ABORTED): the load was replaced or stopped on purpose (a download, a blocked page).
    if (!isMainFrame || code === -3) return;
    const target = url || lastSite.get(contents);
    if (policy.classify(target, SITE) !== 'site') return;
    // Next turn: Chromium first finishes putting its own error page in for the failed load.
    setTimeout(() => showProblem(contents, { url: target, reason: 'offline', code, desc }), 0);
  });
  contents.on('did-navigate', (e, url, httpCode) => {
    if (policy.classify(url, SITE) !== 'site') {
      onCommitted(contents, url);
      return;
    }
    lastSite.set(contents, url);
    if (httpCode >= 500) showProblem(contents, { url, reason: 'server', code: httpCode });
    else if (httpCode > 0) failures = 0; // a real answer (a failed load commits an error page with no code)
  });
  contents.on('did-navigate-in-page', (e, url, isMainFrame) => {
    if (isMainFrame && policy.classify(url, SITE) === 'site') lastSite.set(contents, url);
  });
  contents.on('did-finish-load', () => {
    if (policy.classify(contents.getURL(), SITE) !== 'site') return;
    const main = mainWindow();
    if (state && main && contents === main.webContents && contents.getZoomLevel() !== state.zoom) {
      contents.setZoomLevel(state.zoom);
    }
  });
  contents.on('render-process-gone', (e, details) => {
    if (details.reason === 'clean-exit' || contents.isDestroyed()) return;
    showProblem(contents, { reason: 'crash', code: details.reason });
  });
  // A page that asks "leave this page?" would otherwise keep the window from closing without a word.
  contents.on('will-prevent-unload', (e) => {
    const owner = BrowserWindow.fromWebContents(contents);
    const opts = {
      type: 'question', title: 'antics', buttons: ['Leave', 'Stay'], defaultId: 1, cancelId: 1, noLink: true,
      message: 'Leave this page?', detail: "antics is still busy here. If you leave, what it's doing may stop.",
    };
    const choice = owner ? dialog.showMessageBoxSync(owner, opts) : dialog.showMessageBoxSync(opts);
    if (choice === 0) e.preventDefault();
  });
  contents.on('context-menu', (e, params) => contextMenu(contents, params));
  // Ctrl + mouse wheel (Electron reports it; zooming is up to the app).
  contents.on('zoom-changed', (e, direction) => zoom(contents, direction === 'in' ? 0.5 : -0.5));
  // F5 / Ctrl+F5 reload like a browser; Ctrl and the + / - keys of any keyboard zoom (the menu has Ctrl+= and Ctrl+-);
  // Alt+Left / Alt+Right go back and forward, like a browser.
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.alt && !input.control && !input.meta && !input.shift && (input.key === 'ArrowLeft' || input.key === 'ArrowRight')) {
      e.preventDefault();
      historyStep(contents, input.key === 'ArrowLeft' ? -1 : 1);
      return;
    }
    if (input.alt) return;
    if (input.key === 'F5' && !input.shift && !input.meta) {
      e.preventDefault();
      reload(contents, input.control);
      return;
    }
    if (!(input.control || input.meta)) return;
    if (input.key === '+' || input.code === 'NumpadAdd') {
      e.preventDefault();
      zoom(contents, 0.5);
    } else if (input.code === 'NumpadSubtract') {
      e.preventDefault();
      zoom(contents, -0.5);
    }
  });
}

// The mouse's Back and Forward side buttons (Windows sends them to the window as app commands).
function onAppCommand(contents, cmd) {
  if (cmd === 'browser-backward') historyStep(contents, -1);
  else if (cmd === 'browser-forward') historyStep(contents, 1);
}

// ---------- The session: permissions and saving files ----------

function setupSession() {
  const ses = session.fromPartition(PARTITION);

  ses.setPermissionRequestHandler((contents, permission, callback, details) => {
    const topUrl = contents && !contents.isDestroyed() ? contents.getURL() : null;
    callback(policy.allowRequest(permission, {
      requestingUrl: details.requestingUrl, topUrl, mediaTypes: details.mediaTypes,
    }, SITE));
  });
  ses.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => (
    policy.allowCheck(permission, requestingOrigin, details, SITE)));

  ses.on('will-download', (event, item, contents) => {
    const name = policy.downloadName(item.getFilename(), item.getMimeType());
    // No save path is set, so Windows asks where to save it, starting in the Downloads folder.
    item.setSaveDialogOptions({ title: 'Save', buttonLabel: 'Save', defaultPath: path.join(app.getPath('downloads'), name) });
    const owner = (contents && !contents.isDestroyed() && BrowserWindow.fromWebContents(contents)) || mainWindow();
    const progress = (value) => owner && !owner.isDestroyed() && owner.setProgressBar(value);
    item.on('updated', (e, st) => {
      const total = item.getTotalBytes();
      if (st === 'progressing') progress(total ? item.getReceivedBytes() / total : 2);
      else progress(-1);
    });
    item.once('done', (e, st) => {
      progress(-1);
      if (st === 'completed') savedNote(item.getSavePath());
    });
  });
  return ses;
}

function savedNote(file) {
  try {
    if (!file || !Notification.isSupported()) return;
    const n = new Notification({
      title: 'Saved',
      body: `${path.basename(file)} is in ${path.dirname(file)}. Click to show it.`,
      silent: true,
      // Windows shows the app's own icon on its notifications (and can't read a picture inside app.asar).
      ...(process.platform === 'win32' ? {} : { icon: ICON_PNG }),
    });
    n.on('click', () => shell.showItemInFolder(file));
    n.show();
  } catch {
    // The file is saved either way.
  }
}

// ---------- Menu ----------

function about() {
  const opts = {
    type: 'info', title: 'About antics', message: `antics ${app.getVersion()}`, icon: ICON_PNG, buttons: ['OK'], noLink: true,
    detail: `TENDHA2's antics in its own window.\n\nIt opens ${SITE.url}, so every update to antics is here at once.\n\n`
      + `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
  };
  const w = activeWindow();
  return w ? dialog.showMessageBox(w, opts) : dialog.showMessageBox(opts);
}

// The owner's app link (#app=…) carries the connection to the worker. Copy it anywhere, then choose this.
async function openLinkFromClipboard() {
  const text = String(await clipboard.readText().catch(() => '')).trim(); // (async in Electron 45)
  if (policy.classify(text, SITE) === 'site') {
    const main = mainWindow();
    if (main) {
      main.show();
      main.focus();
    }
    loadSite(new URL(text).href);
    return;
  }
  const opts = {
    type: 'info', title: 'antics', buttons: ['OK'], noLink: true,
    message: 'Copy your antics link first',
    detail: 'On your phone or in your browser: open antics, tap ⚙ Settings, then Copy app link. '
      + 'Send it to this computer (or copy it here), then choose Open my app link again.',
  };
  const w = activeWindow();
  if (w) dialog.showMessageBox(w, opts);
  else dialog.showMessageBox(opts);
}

function buildMenu() {
  const on = (fn) => () => {
    const w = activeWindow();
    if (w) fn(w.webContents, w);
  };
  return Menu.buildFromTemplate([
    {
      label: 'antics',
      submenu: [
        { id: 'open-link', label: 'Open my app link (copied)', accelerator: 'CommandOrControl+L', click: openLinkFromClipboard },
        { type: 'separator' },
        { id: 'reload', label: 'Reload', accelerator: 'CommandOrControl+R', click: on((c) => reload(c)) },
        { id: 'force-reload', label: 'Reload everything', accelerator: 'CommandOrControl+Shift+R', click: on((c) => reload(c, true)) },
        { type: 'separator' },
        { id: 'quit', label: 'Quit antics', accelerator: 'CommandOrControl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'View',
      submenu: [
        // (the keys are handled with the mouse buttons in before-input-event: the menu only shows them)
        { id: 'back', label: 'Back', accelerator: 'Alt+Left', registerAccelerator: false, click: on((c) => historyStep(c, -1)) },
        { id: 'forward', label: 'Forward', accelerator: 'Alt+Right', registerAccelerator: false, click: on((c) => historyStep(c, 1)) },
        { type: 'separator' },
        { id: 'zoom-in', label: 'Zoom in', accelerator: 'CommandOrControl+=', click: on((c) => zoom(c, 0.5)) },
        { id: 'zoom-out', label: 'Zoom out', accelerator: 'CommandOrControl+-', click: on((c) => zoom(c, -0.5)) },
        { id: 'zoom-reset', label: 'Actual size', accelerator: 'CommandOrControl+0', click: on((c) => zoom(c, 0)) },
        { type: 'separator' },
        { id: 'fullscreen', label: 'Toggle full screen', accelerator: 'F11', click: on((c, w) => w.setFullScreen(!w.isFullScreen())) },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { id: 'about', label: 'About antics', click: () => about() },
        { id: 'open-browser', label: 'Open antics in my browser', click: () => openExternal(SITE.url) },
        { type: 'separator' },
        { id: 'devtools', label: 'Developer tools', accelerator: 'CommandOrControl+Shift+I', click: on((c) => c.toggleDevTools()) },
      ],
    },
  ]);
}

// ---------- The window ----------

function createWindow(startUrl) {
  state = windowState.load(stateFile(), screen.getAllDisplays().map((d) => d.workArea));
  win = new BrowserWindow({
    title: 'antics',
    icon: ICON,
    backgroundColor: PAPER,
    show: false,
    width: state.width,
    height: state.height,
    ...(state.x !== undefined ? { x: state.x, y: state.y } : { center: true }),
    minWidth: windowState.MIN.width,
    minHeight: windowState.MIN.height,
    webPreferences: webPreferences(),
  });
  const w = win;
  appPages.set(w.webContents, 'main');
  saveState = windowState.track(w, stateFile(), state);
  w.on('page-title-updated', (e) => e.preventDefault()); // always "antics"
  w.on('app-command', (e, cmd) => onAppCommand(w.webContents, cmd));
  const reveal = () => {
    if (w.isDestroyed() || w.isVisible()) return;
    if (state.maximized) w.maximize();
    w.show();
  };
  w.once('ready-to-show', reveal);
  setTimeout(reveal, 4000); // a slow first load still shows the window
  w.on('close', () => session.fromPartition(PARTITION).flushStorageData());
  w.on('closed', () => {
    if (win === w) win = null;
  });
  loadSite(startUrl || SITE.url, w.webContents);
}

// ---------- Start ----------

if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // notifications and the taskbar use the app's name
// Always the same data folder (%APPDATA%\antics on Windows), however antics is started: the connection, the
// remembered window and the one-copy lock all live there.
try {
  app.setPath('userData', path.resolve(app.getPath('appData'), 'antics'));
} catch {
  // Electron's own choice (also %APPDATA%\antics for the installed app) is used.
}

if (!app.requestSingleInstanceLock()) {
  // antics is open already: that window comes to the front (second-instance) and this copy stops.
  app.quit();
} else {
  app.on('second-instance', (e, argv) => {
    const url = policy.siteUrlFromArgs(argv, SITE);
    const main = mainWindow();
    if (!main) {
      createWindow(url);
      return;
    }
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
    if (url) loadSite(url, main.webContents);
  });
  app.on('web-contents-created', (e, contents) => guard(contents));
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    saveState();
    session.fromPartition(PARTITION).flushStorageData();
  });
  app.whenReady().then(() => {
    setupSession();
    Menu.setApplicationMenu(buildMenu());
    createWindow(policy.siteUrlFromArgs(process.argv.slice(1), SITE));
  });
}
