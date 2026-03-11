const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const isDev = !app.isPackaged;

// ── Single-instance lock ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── Register roy:// deep link protocol (Windows) ───────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("roy", process.execPath, [
      path.resolve(process.argv[1]),
    ]);
  }
} else {
  app.setAsDefaultProtocolClient("roy");
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: "#0A0A0A",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#0A0A0A",
      symbolColor: "#ffffff",
      height: 36,
    },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, "../public/icon.ico"),
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
}

// ── Handle deep link when app is already running (Windows second-instance) ─────
app.on("second-instance", (_event, commandLine) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
  // commandLine is an array; the URL is the last element on Windows
  const deepLink = commandLine.find((arg) => arg.startsWith("roy://"));
  if (deepLink && mainWindow) {
    mainWindow.webContents.send("deep-link", deepLink);
  }
});

// ── Handle deep link on macOS (open-url event) ────────────────────────────────
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (mainWindow) {
    mainWindow.webContents.send("deep-link", url);
  }
});

app.whenReady().then(() => {
  createWindow();

  // Handle cold-start deep link on Windows (URL passed as argv)
  const coldLink = process.argv.find((arg) => arg.startsWith("roy://"));
  if (coldLink && mainWindow) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.send("deep-link", coldLink);
    });
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
