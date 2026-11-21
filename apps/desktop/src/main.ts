// Electron main process for Odin (docs/desktop.md). Wiring only: the decisions live in the
// pure modules next to this file.
import {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { artifactPdfUrl } from "./pdf.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { prober } from "./health.ts";
import { freePort, homeInstance, planPort, recordedPort } from "./ports.ts";
import { rotatingLog } from "./log.ts";
import { isCoreUrl, isExternalOpenable, isTrustedSender } from "./navigation.ts";
import { countsStore, quitPrompt, sessionActivityAt, trayTooltip, TRAY_WAITING_LIMIT, type SessionLite, type TaskLite } from "./counts.ts";
import { eventClient, getJson } from "./events.ts";
import { iconPng, type IconVariant } from "./icons.ts";
import { notifier, sessionIdFromUrl, type NotificationSpec } from "./notify.ts";
import { planOpen, which, type Command, type OpenTarget } from "./open.ts";
import { checkOpenPath } from "./paths.ts";
import { DEFAULT_SETTINGS, openRoots, readShellSettings, type ShellSettings } from "./settings.ts";
import { coreEnv } from "./resources.ts";
import { channelFor } from "./channel.ts";
import { launcherShortcut } from "./shortcut.ts";
import { buildToolPath } from "./tool-path.ts";
import { supervisor, type Supervisor } from "./supervisor.ts";
import { loadWindowState, saveWindowState } from "./window-state.ts";
import { hidesMenuBar, shellCommand, windowChrome, type ShellCommand } from "./chrome.ts";
import { errorPage, ACTION_OPEN_LOG, ACTION_RESTART } from "./error-page.ts";
import { snapshotJournal, startupController } from "./reconcile.ts";

const channel = channelFor(app.isPackaged, process.env);
/** ODIN_PORT pins the port: no moving to a free one. */
const pinnedPort = Number(process.env.ODIN_PORT) > 0;
/** The channel's port until boot settles where this home's core is (see ports.ts). */
let port = channel.port;
let coreOrigin = `http://127.0.0.1:${port}`;
function setPort(p: number) {
  port = p;
  coreOrigin = `http://127.0.0.1:${p}`;
}
const home = resolve(channel.home.replace(/^~(?=$|[\\/])/, homedir()));
// Core inherits this, so it opens the same channel's database. ODIN_PORT is set per spawn.
process.env.ODIN_HOME = home;
if (channel.name === "dev") {
  // A separate name and userData folder also give the dev app its own single-instance lock and window state.
  app.setName(channel.productName);
  app.setPath("userData", join(app.getPath("appData"), channel.productName));
}
const repoRoot = resolve(import.meta.dirname, "../../..");
const stateFile = join(home, "desktop.json");
const log = rotatingLog(join(home, "desktop.log"));

let win: BrowserWindow | null = null;
let core: Supervisor | null = null;
let quitting = false;
let quitConfirmed = false;
let tray: Tray | null = null;
let ipcRegistered = false;
let settings: ShellSettings = DEFAULT_SETTINGS;
/** `--hidden` (start at login): start in the tray, window hidden until asked for. */
const startHidden = process.argv.includes("--hidden");
const LOGIN_ARGS = ["--hidden"];
const counts = countsStore();
const notes = notifier();
type ShellEvent = { type: string; [k: string]: unknown };
const snapshots = snapshotJournal<ShellEvent>();
const taskSnapshots = new Map<string, ReturnType<typeof snapshotJournal<TaskLite>>>();
const shortcut = launcherShortcut(globalShortcut, () => openRoute("/?launch=1"));
const events = eventClient({
  get url() {
    return `${coreOrigin}/api/events`;
  },
  onOpen: () => void reseed(),
  onEvent,
  log: (m) => log.line(m),
});

// The taskbar uses this id, and the raven in build/icon.ico, instead of Electron's own icon.
if (process.platform === "win32") app.setAppUserModelId(channel.appId);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // `--quit` on a second launch quits the running instance (scripted smoke runs; same path as the menu's Quit).
  app.on("second-instance", (_e, argv) => (argv.includes("--quit") ? app.quit() : showWindow()));
  app.whenReady().then(() => boot()).catch((err: unknown) => {
    log.line(`boot failed: ${err instanceof Error ? err.message : String(err)}`);
    showError("Odin could not start.", "See the log for details.", false);
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow(): BrowserWindow {
  const displays = screen.getAllDisplays().map((d) => d.workArea);
  const state = loadWindowState(stateFile, displays);
  const w = new BrowserWindow({
    title: "Odin",
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: false,
    icon: existsSync(join(import.meta.dirname, "../build/icon.ico"))
      ? join(import.meta.dirname, "../build/icon.ico")
      : undefined,
    ...windowChrome(process.platform),
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  if (startHidden) {
    if (state.maximized) w.once("show", () => w.maximize());
  } else {
    if (state.maximized) w.maximize();
    // `ready-to-show` does not fire on Windows once the native title bar is hidden, so also reveal when the
    // page has loaded. Showing twice is harmless.
    const reveal = () => {
      if (w.isDestroyed() || w.isVisible()) return;
      w.show();
    };
    w.once("ready-to-show", reveal);
    w.webContents.once("did-finish-load", reveal);
  }
  // Settings may have changed in the page (there is no settings event): re-read them, and the shortcut, on focus.
  w.on("focus", () => void refreshSettings());

  const persist = () => {
    if (w.isDestroyed()) return;
    const b = w.getNormalBounds();
    saveWindowState(stateFile, { ...b, maximized: w.isMaximized() });
  };
  w.on("close", (e) => {
    persist();
    if (!quitting) {
      // Closing hides to the tray; core and live sessions keep running.
      e.preventDefault();
      w.hide();
    }
  });

  const guard = (e: { preventDefault(): void }, url: string) => {
    if (url === ACTION_RESTART) {
      e.preventDefault();
      void boot().catch((err: unknown) => {
        log.line(`restart failed: ${err instanceof Error ? err.message : String(err)}`);
        showError("Odin could not restart.", "See the log for details.", true);
      });
    } else if (url === ACTION_OPEN_LOG) {
      e.preventDefault();
      void shell.openPath(log.file);
    } else if (!isCoreUrl(url, coreOrigin) && !url.startsWith("data:text/html")) {
      e.preventDefault();
      if (isExternalOpenable(url)) void shell.openExternal(url);
    }
  };
  w.webContents.on("will-navigate", guard);
  w.webContents.on("will-redirect", guard);
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalOpenable(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-attach-webview", (e) => e.preventDefault());
  if (hidesMenuBar(process.platform)) bindShellShortcuts(w);
  return w;
}

function loadApp() {
  void win?.loadURL(coreOrigin + "/");
  events.start();
}

/** Show the window on a route of the web app (`/s/<id>`, `/?launch=1`). */
function openRoute(path: string) {
  if (!win) return;
  void win.loadURL(coreOrigin + path);
  showWindow();
}

// ── counts, tray and notifications ──

function windowView() {
  const focused = !!win && win.isVisible() && win.isFocused();
  return { focused, sessionId: win ? sessionIdFromUrl(win.webContents.getURL()) : null };
}

function notify(n: NotificationSpec) {
  // Ids only in the log: titles stay out of it.
  log.line(`notify: ${n.kind} ${n.sessionId}`);
  if (!Notification.isSupported()) return;
  const note = new Notification({ title: n.title, body: n.body });
  note.on("click", () => openRoute(`/s/${encodeURIComponent(n.sessionId)}`));
  note.show();
}

async function fetchTasks(id: string) {
  const journal = taskSnapshots.get(id) ?? snapshotJournal<TaskLite>();
  taskSnapshots.set(id, journal);
  const token = journal.begin();
  try {
    const detail = (await getJson(`${coreOrigin}/api/sessions/${encodeURIComponent(id)}`)) as { transcript?: unknown };
    const list: TaskLite[] = [];
    if (Array.isArray(detail.transcript))
      for (const e of detail.transcript as { kind?: string; task?: TaskLite }[])
        if (e.kind === "task" && e.task && typeof e.task.taskId === "string") list.push(e.task);
    if (taskSnapshots.get(id) !== journal || !counts.get(id)) return;
    journal.complete(token, () => counts.setTasks(id, list), task => counts.task(id, task));
    renderTray();
  } catch {
    journal.cancel(token);
    tasksLoadedAt.delete(id);
    // the session may be gone; counts stay as they are
  }
}

/** Idle sessions' transcripts are read once per change, for running background work (as the web store does). */
const tasksLoadedAt = new Map<string, string>();
function trackIdleWork() {
  for (const s of counts.idleToCheck(Date.now())) {
    const at = sessionActivityAt(s);
    if (!at || tasksLoadedAt.get(s.id) === at) continue;
    tasksLoadedAt.set(s.id, at);
    void fetchTasks(s.id);
  }
}

async function reseed() {
  const token = snapshots.begin();
  await refreshSettings();
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [live, idle] = await Promise.all([
      getJson(`${coreOrigin}/api/sessions?state=running,waiting`),
      getJson(`${coreOrigin}/api/sessions?state=idle&since=${encodeURIComponent(since)}`),
    ]);
    const list = [...(Array.isArray(live) ? live : []), ...(Array.isArray(idle) ? idle : [])] as SessionLite[];
    if (!snapshots.complete(token, () => {
      counts.seed(list);
      taskSnapshots.clear();
    }, event => applyEvent(event, true))) return;
    for (const n of notes.seed(counts.sessions(), settings, windowView())) notify(n);
    tasksLoadedAt.clear();
    trackIdleWork();
    renderTray();
  } catch (err) {
    snapshots.cancel(token);
    log.line(`could not seed sessions: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function onEvent(ev: ShellEvent) {
  snapshots.observe(ev);
  applyEvent(ev);
}

function applyEvent(ev: ShellEvent, replay = false) {
  if (ev.type === "session.updated" && ev.session && typeof ev.session === "object") {
    const s = ev.session as SessionLite;
    counts.update(s);
    const n = replay ? null : notes.observe(s, settings, windowView());
    if (n) notify(n);
    if (!replay) trackIdleWork();
    renderTray();
  } else if (ev.type === "session.removed" && typeof ev.sessionId === "string") {
    counts.remove(ev.sessionId);
    taskSnapshots.delete(ev.sessionId);
    tasksLoadedAt.delete(ev.sessionId);
    notes.forget(ev.sessionId);
    renderTray();
  } else if (ev.type === "session.event" && typeof ev.sessionId === "string") {
    const e = ev.event as { type?: string; task?: TaskLite } | undefined;
    if (e?.type === "task" && e.task) {
      taskSnapshots.get(ev.sessionId)?.observe(e.task);
      counts.task(ev.sessionId, e.task);
      renderTray();
    }
  }
}

const icons = new Map<IconVariant, NativeImage>();
function icon(variant: IconVariant) {
  let img = icons.get(variant);
  if (!img) {
    img = nativeImage.createFromBuffer(iconPng(variant, 16));
    img.addRepresentation({ scaleFactor: 2, buffer: iconPng(variant, 32) });
    icons.set(variant, img);
  }
  return img;
}

let lastTip = "";
function renderTray() {
  if (!tray) return;
  const c = counts.counts();
  tray.setImage(icon(c.waiting > 0 ? "needs-you" : "normal"));
  const tip = trayTooltip(c);
  if (tip !== lastTip) log.line(`tray: ${(lastTip = tip)}`);
  tray.setToolTip(tip);
  const waiting: MenuItemConstructorOptions[] = c.waitingSessions.slice(0, TRAY_WAITING_LIMIT).map((s) => ({
    label: s.title.length > 60 ? s.title.slice(0, 59) + "…" : s.title,
    click: () => openRoute(`/s/${encodeURIComponent(s.id)}`),
  }));
  const template: MenuItemConstructorOptions[] = [
    { label: "Open Odin", click: () => showWindow() },
    { label: "New session", click: () => openRoute("/?launch=1") },
  ];
  if (waiting.length) template.push({ type: "separator" }, { label: "Needs you", enabled: false }, ...waiting);
  template.push({ type: "separator" }, { label: "Quit", click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  tray = new Tray(icon("normal"));
  tray.on("click", () => showWindow());
  renderTray();
}

async function refreshSettings() {
  try {
    settings = readShellSettings(await getJson(`${coreOrigin}/api/settings`));
  } catch {
    // core unreachable: keep what we had
  }
  shortcut.apply(settings.launcherShortcut);
}

// ── IPC (window.odinDesktop) ──

function trusted(e: IpcMainInvokeEvent): boolean {
  const f = e.senderFrame;
  return isTrustedSender(f ? { url: f.url, isTop: f.parent === null } : null, coreOrigin);
}

function handle(channel: string, fn: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, async (e, ...args: unknown[]) => {
    if (!trusted(e)) throw new Error("not allowed");
    return fn(...args);
  });
}

function trySpawn(attempts: Command[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const next = (i: number) => {
      const a = attempts[i];
      if (!a) return reject(new Error("could not start the program"));
      const child = spawn(a.cmd, a.args, {
        cwd: a.cwd,
        detached: true,
        stdio: "ignore",
        windowsVerbatimArguments: a.verbatim === true,
      });
      child.once("error", () => next(i + 1));
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    };
    next(0);
  });
}

async function openPathFor(path: unknown, target: unknown) {
  if (target !== "editor" && target !== "terminal" && target !== "files") throw new Error("invalid target");
  const roots = openRoots(await getJson(`${coreOrigin}/api/projects`), join(home, "worktrees"));
  const real = await checkOpenPath(path, roots);
  if (target === "editor") await refreshSettings();
  const plan = planOpen(real, target as OpenTarget, settings.editorCommand, {
    platform: process.platform,
    which: (c) => which(c),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
  });
  if (plan.kind === "files") {
    const err = await shell.openPath(plan.path);
    if (err) throw new Error(err);
    return;
  }
  await trySpawn(plan.attempts);
}

function registerIpc() {
  handle("desktop:exportArtifactPdf", async (id, version) => {
    const url = artifactPdfUrl(coreOrigin, id, version);
    // Fetch the saved version before asking for a destination, so a missing artifact cannot export an error page.
    const response = await fetch(url);
    if (!response.ok) throw new Error("Artifact version is unavailable");
    const destination = await dialog.showSaveDialog({ title: "Export report to PDF", defaultPath: `report-${id}-v${version}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (destination.canceled || !destination.filePath) return false;
    const print = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: `pdf-${Date.now()}` } });
    print.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    print.webContents.on("will-navigate", (event, target) => { if (target !== url) event.preventDefault(); });
    print.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    try {
      await print.loadURL(url);
      const pdf = await print.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      await writeFile(destination.filePath, pdf);
      return true;
    } finally { print.destroy(); }
  });
  handle("desktop:openPath", (path, target) =>
    openPathFor(path, target).catch((err: unknown) => {
      log.line(`openPath refused: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }),
  );
  handle("desktop:getLoginItem", () => app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin);
  handle("desktop:setLoginItem", (on) => {
    // Only the installed (stable) app starts at login; from source it would register electron.exe.
    if (channel.name === "dev") throw new Error("Start at login is only available in the installed app.");
    app.setLoginItemSettings({ openAtLogin: on === true, openAsHidden: true, args: LOGIN_ARGS });
  });
  handle("desktop:shortcutStatus", () => shortcut.status());
  handle("desktop:openLog", async () => {
    const err = await shell.openPath(log.file);
    if (err) throw new Error(err);
  });
}

function showError(title: string, detail: string, canRestart: boolean) {
  void win?.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(errorPage(title, detail, canRestart)));
  showWindow();
}

/** Resolved once at boot: GUI launches do not inherit the shell's PATH. */
let toolPath: string | undefined;

function spawnCore() {
  const packaged = app.isPackaged;
  const launch = coreEnv({ packaged, resourcesPath: process.resourcesPath, repoRoot });
  // Dev: ODIN_NODE picks the Node that runs core from source. Packaged: Electron itself runs as Node.
  const command = packaged ? launch.command : process.env.ODIN_NODE || launch.command;
  const env: Record<string, string | undefined> = { ...process.env, ELECTRON_RUN_AS_NODE: undefined };
  if (toolPath) {
    for (const k of Object.keys(env)) if (k.toLowerCase() === "path") delete env[k];
    env[process.platform === "win32" ? "Path" : "PATH"] = toolPath;
  }
  Object.assign(env, launch.env, { ODIN_PORT: String(port) });
  return spawn(command, launch.args, {
    cwd: packaged ? process.resourcesPath : repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
}

function initializeShell() {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  if (hidesMenuBar(process.platform)) Menu.setApplicationMenu(null);
  else buildMenu();
  if (!ipcRegistered) {
    registerIpc();
    ipcRegistered = true;
  }
  if (!tray) createTray();
  if (!win) win = createWindow();
}

const boot = startupController(initializeShell, async () => {
  if (core) {
    await core.restart();
    return;
  }

  mkdirSync(home, { recursive: true });
  const check = prober(homeInstance(home));
  const plan = await planPort({
    preferred: channel.port,
    recorded: pinnedPort ? null : recordedPort(home),
    probe: check,
    freePort,
  });
  if (plan.moved && pinnedPort) {
    showError(
      `Port ${channel.port} is in use.`,
      `Something other than this Odin answers on 127.0.0.1:${channel.port}. Stop it, or unset ODIN_PORT so Odin picks a free port.`,
      true,
    );
    return;
  }
  setPort(plan.port);
  log.line(`port ${port}: ${plan.action}${plan.moved ? ` (moved from ${channel.port})` : ""}`);
  if (plan.action === "attach") {
    loadApp();
    return;
  }
  toolPath ??= await buildToolPath().catch((err: unknown) => {
    log.line(`could not build PATH: ${err instanceof Error ? err.message : String(err)}`);
    return "";
  });
  core ??= supervisor({
    spawnCore,
    check: () => check(port),
    log,
    onHealthy: () => {
      log.line("core healthy");
      loadApp();
    },
    onGaveUp: (reason) => showError("Odin's core stopped.", reason, true),
  });
  await core.start();
});

function runShellCommand(target: BrowserWindow, command: ShellCommand) {
  const page = target.webContents;
  switch (command) {
    case "undo":
      return page.undo();
    case "redo":
      return page.redo();
    case "cut":
      return page.cut();
    case "copy":
      return page.copy();
    case "paste":
      return page.paste();
    case "selectAll":
      return page.selectAll();
    case "reload":
      return page.reload();
    case "forceReload":
      return page.reloadIgnoringCache();
    case "toggleDevTools":
      return page.toggleDevTools();
    case "resetZoom":
      return page.setZoomLevel(0);
    case "zoomIn":
      return page.setZoomLevel(page.getZoomLevel() + 0.5);
    case "zoomOut":
      return page.setZoomLevel(page.getZoomLevel() - 0.5);
    case "toggleFullscreen":
      return target.setFullScreen(!target.isFullScreen());
    case "quit":
      return app.quit();
  }
}

/** The menu bar is gone on Windows and Linux, so the shortcuts it used to provide are handled here. */
function bindShellShortcuts(target: BrowserWindow) {
  target.webContents.on("before-input-event", (event, input) => {
    const command = shellCommand(input);
    if (!command) return;
    event.preventDefault();
    runShellCommand(target, command);
  });
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Odin",
      submenu: [
        { label: "Show window", click: () => showWindow() },
        { label: "Open log", click: () => void shell.openPath(log.file) },
        { type: "separator" },
        { label: "Quit Odin", accelerator: "CmdOrCtrl+Q", click: () => app.quit() },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("activate", () => showWindow());
app.on("window-all-closed", () => {
  // Stay alive: windows only hide; quitting goes through the menu.
});
app.on("before-quit", (e) => {
  if (quitting) return;
  const c = core;
  // Asks first when the core we own (and would stop) has live sessions. An attached core keeps running.
  const prompt = c?.running ? quitPrompt(counts.counts()) : null;
  if (prompt && !quitConfirmed) {
    e.preventDefault();
    const opts = {
      type: "warning" as const,
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: "Quit Odin",
      message: prompt,
    };
    const shown = win && win.isVisible() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    void shown.then(({ response }) => {
      if (response !== 0) return;
      quitConfirmed = true;
      app.quit();
    });
    return;
  }
  quitting = true;
  events.stop();
  globalShortcut.unregisterAll();
  tray?.destroy();
  tray = null;
  if (c?.running) {
    e.preventDefault();
    void c.stop().finally(() => app.exit(0));
  }
});
