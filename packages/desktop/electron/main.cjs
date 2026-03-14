const { app, BrowserWindow, shell, ipcMain, session } = require("electron");
const http = require("http");
const path = require("path");
const isDev = !app.isPackaged;

// ── Bypass self-signed SSL cert for the Roy API server ────────────────────────
// Must be called before app ready. Tells Chromium to ignore cert errors on our
// private API IP so renderer fetch() calls succeed with the self-signed cert.
app.commandLine.appendSwitch("ignore-certificate-errors");

app.on("certificate-error", (event, _webContents, url, _error, _cert, callback) => {
  event.preventDefault();
  callback(true);
});

// ── Single-instance lock ───────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// ── Register roy:// deep link protocol (Windows) — kept as fallback ───────────
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

// ── Local HTTP server for auth callback (port 8642) ───────────────────────────
// Supabase redirects to http://localhost:8642/auth/callback?code=XXXX
// This is far more reliable than custom protocol deep links on Windows.
const AUTH_PORT = 8642;
let authServer = null;

function startAuthServer() {
  authServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${AUTH_PORT}`);
    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");

      // Close the browser tab gracefully
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><head><title>Roy</title></head><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0a0a0a;color:#fff"><div style="text-align:center"><h2>✓ Logged in to Roy</h2><p style="color:#888">You can close this tab.</p><script>window.close()</script></div></body></html>`);

      if (code && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("deep-link", `roy://auth/callback?code=${code}`);
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  authServer.on("error", (err) => {
    console.error("Auth server error:", err.message);
  });

  authServer.listen(AUTH_PORT);
}

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
    icon: isDev
      ? path.join(__dirname, "../public/icon.ico")
      : path.join(__dirname, "../dist/icon.ico"),
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5173");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }

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
  const deepLink = commandLine.find((arg) => arg.startsWith("roy://"));
  if (deepLink && mainWindow) {
    mainWindow.webContents.send("deep-link", deepLink);
  }
});

ipcMain.handle("get-pending-deep-link", () => null);

app.whenReady().then(() => {
  // Grant microphone permission for STT
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === "media") return callback(true);
    callback(false);
  });

  startAuthServer();
  createWindow();
});

app.on("window-all-closed", () => {
  if (authServer) authServer.close();
  app.quit();
});
