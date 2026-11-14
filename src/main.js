const { createLoginEnvironment, validateTicketEndpoint } = require("./auto-login");
const { app, BrowserWindow, ipcMain, nativeImage, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const net = require("net");
const path = require("path");
const config = require("./config");

const DISCORD_INVITE_URL = "https://discord.gg/yuaahEyjR8";
const LAUNCHER_AUTO_LOGIN_ENABLED = true;

let mainWindow;
let currentProgress = null;
let dragState = null;
let launcherSelfUpdatePromise = null;
let launcherSelfUpdateInstalling = false;
let launcherAutoUpdaterConfigured = false;
let launcherUpdateWindow = null;
let launcherUpdateWindowReady = false;
let pendingLauncherUpdateProgress = null;
let selectedClientDir = null;
let selectedClientDirReason = null;
let activePatchBaseUrl = String(config.PUBLIC_PATCH_BASE_URL || "").replace(/\/+$/, "");
let accountSession = {
  token: null,
  cookieHeader: "",
  user: null,
  accounts: [],
  selectedAccountId: null
};

function appRoot() {
  return app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, "..");
}

function installedClientDir() {
  return path.join(appRoot(), "Client");
}

function bundledClientDir() {
  if (!app.isPackaged) return config.AUTHORITATIVE_CLIENT_DIR;
  return path.join(process.resourcesPath, "ClientSeed");
}

function launcherWritableRoot() {
  if (!app.isPackaged) return path.dirname(config.LOCAL_CLIENT_DIR);

  const localAppData = process.env.LOCALAPPDATA
    || process.env.LocalAppData
    || process.env.localappdata;
  if (localAppData) return path.join(localAppData, "BrulunaMS Launcher");

  try {
    return path.join(app.getPath("appData"), "BrulunaMS Launcher");
  } catch {
    const userProfile = process.env.USERPROFILE || process.env.HOME || appRoot();
    return path.join(userProfile, "AppData", "Local", "BrulunaMS Launcher");
  }
}

function portableClientDir() {
  if (!app.isPackaged) return config.LOCAL_CLIENT_DIR;
  if (selectedClientDir) return selectedClientDir;

  const stableClientDir = path.join(launcherWritableRoot(), "Client");
  selectedClientDir = stableClientDir;
  selectedClientDirReason = "stable local app data client folder";
  return selectedClientDir;
}

function launcherDataDir() {
  return path.join(portableClientDir(), ".launcher");
}

function launcherTempDir() {
  return path.join(launcherWritableRoot(), "download-cache");
}

function installStatePath() {
  return path.join(launcherDataDir(), "installed.json");
}

function clientConfigPath() {
  return path.join(portableClientDir(), "config.ini");
}

function patchBaseUrl() {
  return activePatchBaseUrl || String(config.PUBLIC_PATCH_BASE_URL || "").replace(/\/+$/, "");
}

function patchHostName() {
  try {
    return new URL(patchBaseUrl()).hostname;
  } catch {
    return "127.0.0.1";
  }
}

function checkTcpPort(host, port, timeoutMs = config.LIVE_STATUS_TIMEOUT_MS || 1200) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
    socket.connect(port, host);
  });
}

async function canReachPatchBaseUrl(baseUrl, timeoutMs = 800) {
  if (!baseUrl) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${String(baseUrl).replace(/\/+$/, "")}/health`, {
      cache: "no-store",
      signal: controller.signal
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRankings() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(config.RANKINGS_API_URL, {
      cache: "no-store",
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Rankings HTTP ${response.status}`);
    const payload = await response.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const rankings = rows.slice(0, 3).map((row, index) => ({
      rank: Number(row.rank) || index + 1,
      name: String(row.name || "Unknown").slice(0, 24),
      jobName: String(row.jobName || "Beginner").slice(0, 32),
      level: Number(row.level) || 0,
      avatarUrl: String(row.avatarUrl || "")
        .replace(/([?&])resize=\d+/i, "$1resize=3")
        .replace(/([?&])padding=\d+/i, "$1padding=0")
    }));
    return attachRankingAvatarSizes(rankings);
  } finally {
    clearTimeout(timeout);
  }
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function normalizeAccount(row, index = 0) {
  if (!row || typeof row !== "object") {
    const value = firstString(row, `Account ${index + 1}`);
    return { id: value || String(index + 1), name: value || `Account ${index + 1}`, meta: "" };
  }

  const id = firstString(row.id, row.accountId, row.account_id, row.gameAccountId, row.game_account_id, row.username, row.name, index + 1);
  const name = firstString(row.name, row.username, row.login, row.accountName, row.account_name, `Account ${index + 1}`);
  const meta = firstString(row.email, row.status, row.world, row.createdAt, row.created_at);
  return { id, name, meta };
}

function extractToken(payload) {
  return firstString(
    payload?.token,
    payload?.accessToken,
    payload?.access_token,
    payload?.sessionToken,
    payload?.session_token,
    payload?.data?.token,
    payload?.data?.accessToken,
    payload?.data?.access_token,
    payload?.data?.sessionToken,
    payload?.data?.session_token
  );
}

function extractUser(payload, username) {
  const user = payload?.user || payload?.account || payload?.data?.user || payload?.data?.account || {};
  return {
    name: firstString(user.displayName, user.display_name, user.name, user.username, username),
    id: firstString(user.id, user.userId, user.user_id, user.accountId, user.account_id)
  };
}

function extractAccounts(payload) {
  const candidates = [
    payload?.accounts,
    payload?.gameAccounts,
    payload?.game_accounts,
    payload?.characters,
    payload?.data,
    payload?.data?.accounts,
    payload?.data?.gameAccounts,
    payload?.data?.game_accounts,
    payload?.data?.characters,
    payload?.user?.accounts,
    payload?.account?.accounts
  ];
  const rows = candidates.find((candidate) => Array.isArray(candidate)) || [];
  return rows.map(normalizeAccount).filter((account) => account.id && account.name);
}

function splitSetCookieHeader(header) {
  if (!header) return [];
  return String(header)
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function cookieHeaderFromResponse(response) {
  const headers = response.headers;
  const setCookies = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : splitSetCookieHeader(headers.get("set-cookie"));
  return setCookies
    .map((cookie) => String(cookie).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

async function fetchAuthJson(url, options = {}) {
  const { captureCookies, ...fetchOptions } = options;
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "include",
    ...fetchOptions,
    headers: {
      Accept: "application/json",
      ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(fetchOptions.headers || {})
    }
  });
  if (typeof captureCookies === "function") {
    captureCookies(cookieHeaderFromResponse(response));
  }
  const text = await response.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok || payload?.success === false || payload?.ok === false) {
    throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

function authHeaders(token, cookieHeader) {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(cookieHeader ? { Cookie: cookieHeader } : {})
  };
}

function safeIniValue(value) {
  return String(value || "").replace(/[\r\n]/g, "").trim();
}

async function loadAccountList(token, cookieHeader) {
  if (!config.ACCOUNT_LIST_API_URL) return [];
  const payload = await fetchAuthJson(config.ACCOUNT_LIST_API_URL, {
    headers: authHeaders(token, cookieHeader)
  });
  return extractAccounts(payload);
}

function publicAccountSession() {
  return {
    loggedIn: Boolean(accountSession.token || accountSession.user),
    user: accountSession.user,
    accounts: accountSession.accounts,
    selectedAccountId: accountSession.selectedAccountId,
    selectedAccount: accountSession.accounts.find((account) => account.id === accountSession.selectedAccountId) || null
  };
}

async function loginAccount(credentials) {
  const username = String(credentials?.username || "").trim();
  const password = String(credentials?.password || "");
  if (!username || !password) throw new Error("Enter your username/email and password.");

  let cookieHeader = "";
  const loginBodies = [{ email: username, password }];
  if (!username.includes("@")) {
    loginBodies.push({ email: username, username, login: username, password });
  }
  let payload = null;
  let lastError = null;
  for (const body of loginBodies) {
    try {
      payload = await fetchAuthJson(config.LOGIN_API_URL, {
        method: "POST",
        captureCookies: (cookies) => {
          cookieHeader = cookies;
        },
        body: JSON.stringify(body)
      });
      break;
    } catch (error) {
      lastError = error;
      const raw = error?.message || String(error);
      if (username.includes("@") || !/invalid.*email|email.*invalid|HTTP 400|Bad Request/i.test(raw)) {
        break;
      }
    }
  }
  if (!payload) throw lastError || new Error("Login failed.");

  const token = extractToken(payload);
  let accounts = extractAccounts(payload);
  if ((token || cookieHeader) && accounts.length === 0) {
    try {
      accounts = await loadAccountList(token, cookieHeader);
    } catch (error) {
      await logLine("account list load failed after login", { error: serializeError(error) });
    }
  }

  accountSession = {
    token,
    cookieHeader,
    user: extractUser(payload, username),
    accounts,
    selectedAccountId: accounts.length === 1 ? accounts[0].id : null
  };
  await logLine("launcher account login complete", {
    user: accountSession.user?.name,
    accountCount: accountSession.accounts.length,
    selectedAccountId: accountSession.selectedAccountId
  });
  return publicAccountSession();
}

function selectLauncherAccount(accountId) {
  const id = String(accountId || "");
  const exists = accountSession.accounts.some((account) => account.id === id);
  if (!exists) throw new Error("Choose one of your accounts before playing.");
  accountSession.selectedAccountId = id;
  return publicAccountSession();
}

function logoutAccount() {
  accountSession = {
    token: null,
    cookieHeader: "",
    user: null,
    accounts: [],
    selectedAccountId: null
  };
  return publicAccountSession();
}

function publicAuthError(error, attemptedLogin = "") {
  const raw = error?.message || String(error);
  if (/Invalid login credentials/i.test(raw)) {
    return "Invalid username/email or password.";
  }
  if (/invalid.*email|email.*invalid/i.test(raw)) {
    return "Invalid username/email or password.";
  }
  if (/ENOTFOUND|EAI_AGAIN|fetch failed|remote name could not be resolved|getaddrinfo/i.test(raw)) {
    return "Login service is unreachable right now.";
  }
  if (/HTTP 404/i.test(raw)) {
    return "Launcher login endpoint is not configured correctly.";
  }
  if (/HTTP 401|Invalid login credentials|Unauthorized/i.test(raw)) {
    return "Invalid username/email or password.";
  }
  return raw.replace(/^Error:\s*/i, "") || "Login failed.";
}

async function getAvatarVisibleMetrics(avatarUrl) {
  try {
    const response = await fetch(avatarUrl, { cache: "no-store" });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const image = nativeImage.createFromBuffer(buffer);
    return image.getSize();
  } catch {
    return null;
  }
}

async function attachRankingAvatarSizes(rankings) {
  const metrics = await Promise.all(rankings.map((ranking) => getAvatarVisibleMetrics(ranking.avatarUrl)));
  const displayScale = 1.1;

  return rankings.map((ranking, index) => {
    const metric = metrics[index];
    if (!metric?.width) return { ...ranking, avatarWidth: null };
    return {
      ...ranking,
      avatarWidth: Math.round(metric.width * displayScale)
    };
  });
}

async function selectPatchBaseUrl() {
  const publicUrl = String(config.PUBLIC_PATCH_BASE_URL || "").replace(/\/+$/, "");
  const localUrl = String(config.LOCAL_PATCH_BASE_URL || "").replace(/\/+$/, "");
  activePatchBaseUrl = publicUrl;

  if (config.PREFER_LOCAL_PATCH_WHEN_AVAILABLE && localUrl && await canReachPatchBaseUrl(localUrl)) {
    activePatchBaseUrl = localUrl;
    await logLine("selected local patch server", { patchBaseUrl: activePatchBaseUrl, publicPatchBaseUrl: publicUrl });
    return activePatchBaseUrl;
  }

  await logLine("selected public patch server", { patchBaseUrl: activePatchBaseUrl, localPatchBaseUrl: localUrl });
  return activePatchBaseUrl;
}

function launcherLogPath() {
  return path.join(app.getPath("userData"), "logs", "launcher.log");
}

function visibleLauncherLogPath() {
  return path.join(launcherWritableRoot(), "launcher.log");
}

function launcherLogPaths() {
  const paths = [
    launcherLogPath(),
    visibleLauncherLogPath(),
    path.join(launcherWritableRoot(), "logs", "launcher.log")
  ];
  return [...new Set(paths.map((filePath) => path.normalize(filePath)))];
}

async function logLine(message, details = {}) {
  try {
    const line = JSON.stringify({
      time: new Date().toISOString(),
      version: app.getVersion(),
      message,
      ...details
    });
    for (const filePath of launcherLogPaths()) {
      try {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.appendFile(filePath, `${line}\n`, "utf8");
      } catch {
        // Try the next log path.
      }
    }
  } catch {
    // Logging must never block launcher work.
  }
}

function serializeError(error) {
  return {
    name: error?.name,
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
    message: error?.message || String(error),
    stack: error?.stack
  };
}

function emitStatus(status, detail) {
  if (!mainWindow) return;
  mainWindow.webContents.send("launcher:status", { status, detail });
}

function emitProgress(progress) {
  currentProgress = progress;
  if (!mainWindow) return;
  mainWindow.webContents.send("launcher:progress", progress);
}

function launcherUpdateHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    html, body {
      width: 100%;
      height: 100%;
      margin: 0;
      overflow: hidden;
      font-family: "Trebuchet MS", "Segoe UI", Arial, sans-serif;
      color: #ffffff;
      background: transparent;
      user-select: none;
    }
    .frame {
      position: relative;
      box-sizing: border-box;
      width: 100vw;
      height: 100vh;
      padding: 30px 34px;
      overflow: hidden;
      border: 1px solid rgba(220, 246, 255, 0.72);
      border-radius: 24px;
      background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.2), rgba(107, 205, 255, 0.1) 45%, rgba(28, 72, 172, 0.28)),
        radial-gradient(circle at 18% 14%, rgba(255, 255, 255, 0.32), transparent 26%),
        radial-gradient(circle at 85% 90%, rgba(83, 203, 255, 0.2), transparent 30%),
        linear-gradient(145deg, rgba(34, 86, 185, 0.88), rgba(15, 39, 106, 0.92));
      box-shadow:
        inset 0 1px 0 rgba(255, 255, 255, 0.44),
        inset 0 -22px 36px rgba(41, 111, 214, 0.14),
        0 22px 54px rgba(0, 12, 42, 0.55);
      backdrop-filter: blur(7px) saturate(1.18);
    }
    .frame::before,
    .frame::after {
      position: absolute;
      content: "";
      pointer-events: none;
    }
    .frame::before {
      inset: 1px;
      border-radius: 22px;
      background:
        linear-gradient(120deg, rgba(255, 255, 255, 0.24), transparent 34%, rgba(255, 255, 255, 0.1) 62%, transparent 80%),
        linear-gradient(90deg, rgba(255, 255, 255, 0.08), rgba(72, 180, 255, 0.05));
      mix-blend-mode: screen;
    }
    .frame::after {
      left: -28%;
      top: -28%;
      width: 66%;
      height: 150%;
      background: linear-gradient(105deg, transparent 18%, rgba(255, 255, 255, 0.22), transparent 76%);
      transform: rotate(14deg);
      animation: update-sheen 3.8s ease-in-out infinite;
    }
    .caustic {
      position: absolute;
      width: 270px;
      height: 92px;
      border-radius: 999px;
      background:
        radial-gradient(ellipse at 24% 50%, rgba(255, 255, 255, 0.2), transparent 34%),
        radial-gradient(ellipse at 58% 45%, rgba(160, 231, 255, 0.15), transparent 38%),
        linear-gradient(92deg, transparent 8%, rgba(232, 252, 255, 0.13), transparent 78%);
      filter: blur(0.7px);
      mix-blend-mode: screen;
      opacity: 0.25;
      pointer-events: none;
      animation: update-caustic 4.8s ease-in-out infinite;
    }
    .caustic.one {
      left: -72px;
      top: 38px;
      --start-rotate: -13deg;
      --end-rotate: 7deg;
    }
    .caustic.two {
      right: -76px;
      bottom: 22px;
      --start-rotate: 18deg;
      --end-rotate: -6deg;
      animation-delay: 1.2s;
    }
    .content {
      position: relative;
      z-index: 2;
    }
    .title {
      margin: 0 0 8px;
      font-size: 24px;
      font-weight: 900;
      letter-spacing: 0.02em;
      text-shadow: 0 2px 10px rgba(0, 20, 88, 0.62);
    }
    .detail {
      min-height: 18px;
      margin: 0 0 22px;
      color: #d9efff;
      font-size: 13px;
      font-weight: 800;
    }
    .bar {
      position: relative;
      height: 18px;
      overflow: hidden;
      border: 1px solid rgba(224, 247, 255, 0.78);
      border-radius: 999px;
      background: rgba(6, 24, 72, 0.5);
      box-shadow:
        inset 0 2px 5px rgba(0, 0, 0, 0.28),
        0 0 18px rgba(89, 208, 255, 0.12);
    }
    .fill {
      width: 0%;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #62ddff, #3b8bff 55%, #9dd7ff);
      box-shadow: 0 0 18px rgba(92, 210, 255, 0.68);
      transition: width 140ms ease;
    }
    .percent {
      margin-top: 12px;
      color: #ffffff;
      font-size: 18px;
      font-weight: 900;
      text-align: right;
      text-shadow: 0 2px 7px rgba(0, 21, 84, 0.55);
    }
    @keyframes update-sheen {
      0%, 45% { transform: translate3d(0, 0, 0) rotate(14deg); opacity: 0; }
      58% { opacity: 0.48; }
      100% { transform: translate3d(230%, 0, 0) rotate(14deg); opacity: 0; }
    }
    @keyframes update-caustic {
      0%, 100% {
        transform: translate3d(-10px, 0, 0) rotate(var(--start-rotate)) scaleX(0.9) scaleY(0.94);
        opacity: 0.12;
      }
      50% {
        transform: translate3d(18px, -7px, 0) rotate(var(--end-rotate)) scaleX(1.08) scaleY(1.04);
        opacity: 0.28;
      }
    }
  </style>
</head>
<body>
  <main class="frame">
    <span class="caustic one"></span>
    <span class="caustic two"></span>
    <section class="content">
      <h1 class="title">Launcher is updating</h1>
      <p id="detail" class="detail">Preparing update...</p>
      <div class="bar"><div id="fill" class="fill"></div></div>
      <div id="percent" class="percent">0%</div>
    </section>
  </main>
  <script>
    window.setLauncherUpdateProgress = (progress) => {
      const percent = Math.max(0, Math.min(100, Number(progress.percent || 0)));
      document.getElementById("fill").style.width = percent + "%";
      document.getElementById("percent").textContent = Math.round(percent) + "%";
      document.getElementById("detail").textContent = progress.detail || "Updating launcher...";
    };
  </script>
</body>
</html>`;
}

async function showLauncherUpdateWindow() {
  if (launcherUpdateWindow && !launcherUpdateWindow.isDestroyed()) {
    launcherUpdateWindow.show();
    launcherUpdateWindow.focus();
    return;
  }

  launcherUpdateWindowReady = false;
  launcherUpdateWindow = new BrowserWindow({
    width: 430,
    height: 190,
    resizable: false,
    maximizable: false,
    minimizable: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    skipTaskbar: false,
    title: "Launcher is updating",
    icon: path.join(__dirname, "..", "assets", "icon.ico"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  launcherUpdateWindow.on("closed", () => {
    launcherUpdateWindow = null;
    launcherUpdateWindowReady = false;
  });
  launcherUpdateWindow.webContents.once("did-finish-load", () => {
    launcherUpdateWindowReady = true;
    if (pendingLauncherUpdateProgress) {
      setLauncherUpdateWindowProgress(pendingLauncherUpdateProgress);
    }
  });
  await launcherUpdateWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(launcherUpdateHtml())}`);
}

function setLauncherUpdateWindowProgress(progress) {
  pendingLauncherUpdateProgress = progress;
  if (!launcherUpdateWindow || launcherUpdateWindow.isDestroyed() || !launcherUpdateWindowReady) return;
  launcherUpdateWindow.webContents.executeJavaScript(
    `window.setLauncherUpdateProgress(${JSON.stringify(progress)})`,
    true
  ).catch(() => {});
}

async function beginLauncherUpdateUi(detail = "Preparing launcher update...") {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  await showLauncherUpdateWindow();
  setLauncherUpdateWindowProgress({ percent: 0, detail });
}

function updateLauncherUpdateProgress(progress) {
  const total = progress.total || 0;
  const downloaded = progress.downloaded || progress.transferred || 0;
  const percent = Math.max(0, Math.min(100, progress.percent || (total ? (downloaded / total) * 100 : 0)));
  const detail = progress.phase === "LauncherInstalling"
    ? "Installing update silently..."
    : total
      ? `Downloading ${Math.round(percent)}%`
      : "Downloading launcher update...";
  setLauncherUpdateWindowProgress({ percent, detail });
}

function toUrl(urlOrPath) {
  if (/^https?:\/\//i.test(urlOrPath)) return urlOrPath;
  return `${patchBaseUrl()}${urlOrPath.startsWith("/") ? "" : "/"}${urlOrPath}`;
}

function normalizeManifestPath(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("../") || normalized === "..") {
    throw new Error(`Unsafe manifest path: ${filePath}`);
  }
  return normalized;
}

function globToRegExp(pattern) {
  const normalized = pattern.replace(/\\/g, "/");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${source}$`, "i");
}

const protectedRules = config.PROTECTED_PATTERNS.map(globToRegExp);

function isProtectedPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, "/");
  return protectedRules.some((rule) => rule.test(normalized));
}

async function shouldPreserveExistingFile(relativePath, forceFullVerify) {
  if (forceFullVerify || !isProtectedPath(relativePath)) return false;
  return pathExists(path.join(portableClientDir(), relativePath));
}

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyDirectory(sourceDir, targetDir) {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  await fsp.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    if (entry.name === ".launcher") continue;
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else if (entry.isFile()) {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.copyFile(source, target);
    }
  }
}

async function bootstrapClientDir() {
  if (app.isPackaged) {
    const stableClientDir = path.join(launcherWritableRoot(), "Client");
    const installClientDir = installedClientDir();
    const stableExe = path.join(stableClientDir, config.GAME_EXE_NAME);
    const installExe = path.join(installClientDir, config.GAME_EXE_NAME);

    if (!fs.existsSync(stableExe) && fs.existsSync(installExe)) {
      emitStatus("Migrating client");
      await fsp.mkdir(stableClientDir, { recursive: true });
      await copyDirectory(installClientDir, stableClientDir);
      const installedState = path.join(installClientDir, ".launcher", "installed.json");
      if (fs.existsSync(installedState)) {
        await fsp.mkdir(path.join(stableClientDir, ".launcher"), { recursive: true });
        await fsp.copyFile(installedState, path.join(stableClientDir, ".launcher", "installed.json"));
      }
      selectedClientDir = stableClientDir;
      selectedClientDirReason = "migrated client to stable local app data folder";
    }
  }

  const clientDir = portableClientDir();
  await logLine("selected client folder", {
    clientDir,
    reason: selectedClientDirReason || "development client folder",
    installedClientDir: installedClientDir(),
    bundledClientDir: bundledClientDir(),
    localAppDataClientDir: path.join(launcherWritableRoot(), "Client")
  });

  const requiredExe = path.join(clientDir, config.GAME_EXE_NAME);
  if (await pathExists(requiredExe)) return;

  const bundledDir = bundledClientDir();
  const bundledExe = path.join(bundledDir, config.GAME_EXE_NAME);
  await fsp.mkdir(clientDir, { recursive: true });

  if (await pathExists(bundledExe)) {
    emitStatus("Preparing client");
    await copyDirectory(bundledDir, clientDir);
  }
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryFileOperation(operation, description, attempts = 8) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await logLine("file operation failed", {
        description,
        attempt,
        attempts,
        error: serializeError(error)
      });
      if (!["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(error?.code) || attempt === attempts) {
        break;
      }
      await sleep(150 * attempt);
    }
  }
  throw new Error(`${description} failed: ${lastError?.message || lastError}`);
}

function stagedPathForFile(stagingRoot, file) {
  const hash = file.sha256 || crypto.createHash("sha256").update(file.path).digest("hex");
  return path.join(stagingRoot, "files", hash.slice(0, 2), hash);
}

function isRetryableDownloadError(error) {
  return ["EBUSY", "EPERM", "EACCES", "UNKNOWN"].includes(error?.code);
}

function stagingRootCandidates() {
  const suffix = `staging-${process.pid}-${Date.now()}`;
  const candidates = [
    path.join(launcherTempDir(), suffix),
    path.join(launcherDataDir(), "download-cache", suffix)
  ];

  const tempDir = process.env.TEMP || process.env.TMP;
  if (tempDir) {
    candidates.push(path.join(tempDir, "BrulunaMS-Launcher", suffix));
  }

  try {
    candidates.push(path.join(app.getPath("temp"), "BrulunaMS-Launcher", suffix));
  } catch {
    // Ignore missing Electron temp path; the env temp fallback above usually exists.
  }

  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
}

async function prepareWritableStagingRoot() {
  let lastError;
  for (const stagingRoot of stagingRootCandidates()) {
    try {
      await fsp.rm(stagingRoot, { recursive: true, force: true });
      await fsp.mkdir(stagingRoot, { recursive: true });
      const probePath = path.join(stagingRoot, `write-probe-${process.pid}.tmp`);
      await fsp.writeFile(probePath, "ok");
      await fsp.rm(probePath, { force: true });
      await logLine("selected writable staging root", { stagingRoot });
      return stagingRoot;
    } catch (error) {
      lastError = error;
      await logLine("staging root unavailable", {
        stagingRoot,
        error: serializeError(error)
      });
    }
  }

  throw new Error(`Could not create a writable download folder: ${lastError?.message || lastError}`);
}

async function downloadWithCurl(url, tempTarget) {
  await logLine("curl fallback start", { url, tempTarget });
  await new Promise((resolve, reject) => {
    const child = childProcess.spawn("curl.exe", [
      "--fail",
      "--location",
      "--silent",
      "--show-error",
      "--retry",
      "3",
      "--retry-delay",
      "1",
      "--output",
      tempTarget,
      url
    ], {
      windowsHide: true
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`curl.exe failed with code ${code}: ${stderr.trim()}`));
      }
    });
  });
  await logLine("curl fallback complete", { url, tempTarget });
}

async function downloadWithNodeStream(url, tempTarget, file, downloadedStart, totalBytes) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Failed to download ${file.path}: HTTP ${response.status}`);

  const writer = fs.createWriteStream(tempTarget, { flags: "wx" });
  const reader = response.body.getReader();
  let downloaded = downloadedStart;

  await new Promise(async (resolve, reject) => {
    writer.once("error", reject);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!writer.write(Buffer.from(value))) {
          await new Promise((drainResolve) => writer.once("drain", drainResolve));
        }
        downloaded += value.byteLength;
        emitProgress({ phase: "Downloading", downloaded, total: totalBytes });
      }
      writer.end(resolve);
    } catch (error) {
      writer.destroy();
      reject(error);
    }
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function readInstallState() {
  try {
    return JSON.parse(await fsp.readFile(installStatePath(), "utf8"));
  } catch {
    return null;
  }
}

async function getLatest() {
  return fetchJson(`${patchBaseUrl()}/latest.json`);
}

async function getManifest(latest) {
  const manifestText = await (await fetch(toUrl(latest.manifestUrl), { cache: "no-store" })).text();
  const actualHash = crypto.createHash("sha256").update(manifestText).digest("hex");
  if (latest.manifestSha256 && actualHash !== latest.manifestSha256) {
    throw new Error("Server manifest hash did not match latest.json.");
  }
  return JSON.parse(manifestText);
}

async function checkUpdates(forceFullVerify = false) {
  await bootstrapClientDir();
  emitStatus("Checking");
  if (!app.isPackaged && config.DISABLE_CLIENT_PATCHING_IN_DEV) {
    await logLine("client patching skipped in development", {
      clientDir: portableClientDir(),
      forceFullVerify
    });
    return {
      ready: true,
      latest: null,
      manifest: { files: [] },
      changed: [],
      deletions: [],
      totalBytes: 0,
      clientDir: portableClientDir()
    };
  }
  const latest = await getLatest();
  const state = await readInstallState();

  if (!forceFullVerify && state && state.manifestSha256 === latest.manifestSha256) {
    const manifest = await getManifest(latest);

    return {
      ready: true,
      latest,
      manifest,
      changed: [],
      deletions: [],
      totalBytes: 0,
      clientDir: portableClientDir()
    };
  }

  const manifest = await getManifest(latest);
  const changed = [];
  let totalBytes = 0;

  for (const file of manifest.files || []) {
    const relativePath = normalizeManifestPath(file.path);
    const localPath = path.join(portableClientDir(), relativePath);

    if (await shouldPreserveExistingFile(relativePath, forceFullVerify)) {
      continue;
    }

    let needsUpdate = true;
    try {
      const stat = await fsp.stat(localPath);
      if (stat.size === file.size) {
        needsUpdate = (await sha256File(localPath)) !== file.sha256;
      }
    } catch {
      needsUpdate = true;
    }

    if (needsUpdate) {
      changed.push({ ...file, path: relativePath });
      totalBytes += file.size || 0;
    }
  }

  const deletions = (manifest.delete || [])
    .map(normalizeManifestPath)
    .filter((relativePath) => !isProtectedPath(relativePath));

  return {
    ready: changed.length === 0 && deletions.length === 0,
    latest,
    manifest,
    changed,
    deletions,
    totalBytes,
    clientDir: portableClientDir()
  };
}

function gameExecutableNames() {
  return [
    config.GAME_EXE_NAME,
    "BrulunaMS_Windowed.exe",
    "BrulunaMS_Fullscreen.exe"
  ];
}

function isSameOrInsidePath(candidatePath, rootPath) {
  if (!candidatePath || !rootPath) return false;
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relativePath === "" || (!!relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (quoted && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current);
  return values;
}

function uniqueRunningGameProcesses(processes) {
  const seen = new Set();
  return processes.filter((processInfo) => {
    const key = String(processInfo.pid || `${processInfo.name}:${processInfo.executablePath || ""}`).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function listRunningGameProcesses() {
  const exeNames = gameExecutableNames();
  const allowedNames = new Set(exeNames.map((exeName) => exeName.toLowerCase()));
  const clientDir = portableClientDir();

  if (process.platform === "win32") {
    const command = [
      "$ErrorActionPreference = 'SilentlyContinue';",
      "Get-CimInstance Win32_Process |",
      "Where-Object { @('BrulunaMS.exe','BrulunaMS_Windowed.exe','BrulunaMS_Fullscreen.exe') -contains $_.Name } |",
      "Select-Object ProcessId,Name,ExecutablePath,CommandLine |",
      "ConvertTo-Json -Compress"
    ].join(" ");

    try {
      const stdout = await new Promise((resolve, reject) => {
        childProcess.execFile("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          command
        ], { windowsHide: true, timeout: 5000 }, (error, output) => {
          if (error) return reject(error);
          resolve(output || "");
        });
      });

      const trimmed = stdout.trim();
      if (trimmed) {
        const parsed = JSON.parse(trimmed);
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        return uniqueRunningGameProcesses(rows
          .map((row) => ({
            pid: Number(row.ProcessId) || 0,
            name: String(row.Name || ""),
            executablePath: String(row.ExecutablePath || ""),
            commandLine: String(row.CommandLine || "")
          }))
          .filter((row) => allowedNames.has(row.name.toLowerCase()))
          .filter((row) => !row.executablePath || isSameOrInsidePath(row.executablePath, clientDir)));
      }
    } catch (error) {
      await logLine("process check CIM failed", { error: serializeError(error) });
    }

    return new Promise((resolve) => {
      childProcess.execFile("tasklist.exe", ["/FO", "CSV", "/NH"], { windowsHide: true }, (error, stdout) => {
        if (error) return resolve([]);
        const matches = String(stdout || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map(parseCsvLine)
          .filter((columns) => allowedNames.has(String(columns[0] || "").toLowerCase()))
          .map((columns) => ({
            name: columns[0],
            pid: Number(columns[1]) || 0,
            executablePath: "",
            commandLine: ""
          }));
        resolve(uniqueRunningGameProcesses(matches));
      });
    });
  }

  return [];
}

async function isGameRunning() {
  const matches = await listRunningGameProcesses();
  return matches.length > 0;
}

function formatRunningGameProcesses(processes) {
  return processes
    .map((processInfo) => `${processInfo.name}${processInfo.pid ? ` PID ${processInfo.pid}` : ""}`)
    .join(", ");
}

async function downloadFile(file, stagingRoot, downloadedStart, totalBytes) {
  if (await stageBundledFileIfAvailable(file, stagingRoot, downloadedStart, totalBytes)) {
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      return await downloadFileAttempt(file, stagingRoot, downloadedStart, totalBytes, attempt);
    } catch (error) {
      lastError = error;
      await logLine("download attempt failed", {
        file: file.path,
        attempt,
        attempts: 6,
        retryable: isRetryableDownloadError(error),
        error: serializeError(error)
      });

      if (!isRetryableDownloadError(error) || attempt === 6) break;
      await sleep(350 * attempt);
    }
  }

  throw lastError;
}

async function stageBundledFileIfAvailable(file, stagingRoot, downloadedStart, totalBytes) {
  const bundledPath = path.join(bundledClientDir(), file.path);
  if (!(await pathExists(bundledPath))) return false;

  try {
    const actualHash = await sha256File(bundledPath);
    if (actualHash !== file.sha256) {
      await logLine("bundled client file hash mismatch", {
        file: file.path,
        bundledPath,
        expected: file.sha256,
        actual: actualHash
      });
      return false;
    }

    const target = stagedPathForFile(stagingRoot, file);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await retryFileOperation(async () => {
      await fsp.rm(target, { force: true });
      await fsp.copyFile(bundledPath, target);
    }, `Staging bundled ${file.path}`);

    await logLine("staged bundled client file", {
      file: file.path,
      bundledPath,
      stagedPath: target,
      sha256: file.sha256
    });
    emitProgress({ phase: "Downloading", downloaded: downloadedStart + (file.size || 0), total: totalBytes });
    return true;
  } catch (error) {
    await logLine("staging bundled client file failed", {
      file: file.path,
      bundledPath,
      error: serializeError(error)
    });
    return false;
  }
}

async function downloadFileAttempt(file, stagingRoot, downloadedStart, totalBytes, attempt) {
  const url = toUrl(file.url);
  await logLine("download start", {
    file: file.path,
    size: file.size,
    sha256: file.sha256,
    url,
    stagingRoot,
    attempt
  });

  const target = stagedPathForFile(stagingRoot, file);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tempTarget = path.join(
    path.dirname(target),
    `${crypto.randomUUID ? crypto.randomUUID() : `${process.pid}-${Date.now()}-${attempt}`}.tmp`
  );
  await fsp.rm(tempTarget, { force: true });

  try {
    await downloadWithCurl(url, tempTarget);
    emitProgress({ phase: "Downloading", downloaded: downloadedStart + (file.size || 0), total: totalBytes });
  } catch (error) {
    await logLine("curl download failed, trying node stream", {
      file: file.path,
      attempt,
      tempTarget,
      error: serializeError(error)
    });
    await fsp.rm(tempTarget, { force: true });
    await downloadWithNodeStream(url, tempTarget, file, downloadedStart, totalBytes);
  }

  const actualHash = await sha256File(tempTarget);
  if (actualHash !== file.sha256) {
    await logLine("download hash mismatch", {
      file: file.path,
      expected: file.sha256,
      actual: actualHash,
      tempTarget
    });
    throw new Error(`Downloaded file failed hash check: ${file.path}`);
  }

  await retryFileOperation(async () => {
    await fsp.rm(target, { force: true });
    await fsp.rename(tempTarget, target);
  }, `Finalizing download ${file.path}`);

  await logLine("download complete", {
    file: file.path,
    stagedPath: target,
    sha256: file.sha256
  });
}

async function moveStagedFiles(stagingRoot, files, totalCount) {
  let applied = 0;
  for (const file of files) {
    const source = stagedPathForFile(stagingRoot, file);
    const target = path.join(portableClientDir(), file.path);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await retryFileOperation(async () => {
      await fsp.rm(target, { force: true });
      try {
        await fsp.rename(source, target);
      } catch (error) {
        if (error?.code !== "EXDEV") throw error;
        await fsp.copyFile(source, target);
        await fsp.rm(source, { force: true });
      }
    }, `Installing ${file.path}`);
    await logLine("install file complete", {
      file: file.path,
      target,
      sha256: file.sha256
    });
    applied += 1;
    emitProgress({ phase: "Installing", applied, total: totalCount });
  }
}

async function cleanupLegacyClientJunk() {
  const legacyNames = new Set([
    "apply_quest_window_patch.ps1",
    "config.properties",
    "GMSv62.exe",
    "GMSv62_Windowed.exe",
    "GMSv62_Windowed_2.exe",
    "GMSv62_Windowed_cashdrop.exe",
    "MapleClientLauncher.cpp",
    "MapleClientLauncher.exe",
    "MapleClientMod.cpp",
    "launcher_selected_client.txt",
    "MapleStory.exe",
    "Patcher.exe",
    "Setup.exe"
  ].map((name) => name.toLowerCase()));
  const junkPattern = /(\.backup-|\.before-|\.bad-|\.patched-|\.pending-|\.tmp$|\.bak$|_debug\.txt$|_trace\.txt$|^debug\.txt$|^launcher_debug\.txt$|^launcher_selected_client\.txt$)/i;

  async function visit(current) {
    let entries;
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === ".patch" || entry.name === ".launcher") continue;
      const absolute = path.join(current, entry.name);
      const relativePath = path.relative(portableClientDir(), absolute).replace(/\\/g, "/");
      const lowerName = entry.name.toLowerCase();

      if (entry.isDirectory()) {
        if (/^(backup|backups|backup-before-)/i.test(entry.name)) {
          await fsp.rm(absolute, { recursive: true, force: true });
        } else {
          await visit(absolute);
        }
        continue;
      }

      if (entry.isFile() && (legacyNames.has(lowerName) || junkPattern.test(relativePath) || lowerName.endsWith(".cpp"))) {
        await fsp.rm(absolute, { force: true });
      }
    }
  }

  await visit(portableClientDir());
}

async function applyUpdates(updateInfo) {
  const runningGameProcesses = await listRunningGameProcesses();
  if (runningGameProcesses.length > 0) {
    throw new Error(`${formatRunningGameProcesses(runningGameProcesses)} running. Close the game before patching.`);
  }

  await fsp.mkdir(launcherDataDir(), { recursive: true });
  const stagingRoot = await prepareWritableStagingRoot();

  await logLine("apply updates start", {
    gameVersion: updateInfo.latest?.gameVersion,
    manifestSha256: updateInfo.latest?.manifestSha256,
    changed: updateInfo.changed.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    deletions: updateInfo.deletions,
    totalBytes: updateInfo.totalBytes,
    clientDir: portableClientDir(),
    stagingRoot,
    tempDir: path.dirname(stagingRoot)
  });

  try {
    let downloaded = 0;
    for (const file of updateInfo.changed) {
      await downloadFile(file, stagingRoot, downloaded, updateInfo.totalBytes);
      downloaded += file.size || 0;
    }

    emitStatus("Installing");
    await moveStagedFiles(stagingRoot, updateInfo.changed, updateInfo.changed.length);
    await cleanupLegacyClientJunk();

    for (const relativePath of updateInfo.deletions) {
      if (!isProtectedPath(relativePath)) {
        await retryFileOperation(
          async () => fsp.rm(path.join(portableClientDir(), relativePath), { recursive: true, force: true }),
          `Deleting ${relativePath}`
        );
      }
    }

    await fsp.writeFile(installStatePath(), JSON.stringify({
      gameVersion: updateInfo.latest.gameVersion,
      manifestSha256: updateInfo.latest.manifestSha256,
      installedAt: new Date().toISOString()
    }, null, 2));

    emitStatus("Cleaning up");
    await ensureDefaultClientConfig();
    await logLine("apply updates complete", {
      gameVersion: updateInfo.latest?.gameVersion,
      changedCount: updateInfo.changed.length
    });
  } catch (error) {
    await logLine("apply updates failed", {
      error: serializeError(error),
      clientDir: portableClientDir(),
      stagingRoot,
      logPath: launcherLogPath()
    });
    throw error;
  } finally {
    await fsp.rm(stagingRoot, { recursive: true, force: true }).catch((error) => logLine("staging cleanup failed", {
      stagingRoot,
      error: serializeError(error)
    }));
  }
}

async function ensureDefaultClientConfig() {
  await fsp.mkdir(portableClientDir(), { recursive: true });
  const configPath = clientConfigPath();
  if (await pathExists(configPath)) return;

  await fsp.writeFile(configPath, buildClientConfig({}), "ascii");
}

function readIniValue(text, section, key) {
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      inSection = sectionMatch[1].toLowerCase() === section.toLowerCase();
      continue;
    }

    if (!inSection) continue;
    const keyMatch = line.match(/^\s*([^=]+?)\s*=\s*(.*)\s*$/);
    if (keyMatch && keyMatch[1].trim().toLowerCase() === key.toLowerCase()) {
      return keyMatch[2].trim();
    }
  }
  return "";
}

function setIniValue(text, section, key, value) {
  const lines = text.split(/\r?\n/);
  let sectionStart = -1;
  let insertAt = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const sectionMatch = lines[i].match(/^\s*\[([^\]]+)\]\s*$/);
    if (!sectionMatch) continue;

    if (sectionStart >= 0) {
      insertAt = i;
      break;
    }

    if (sectionMatch[1].toLowerCase() === section.toLowerCase()) {
      sectionStart = i;
      insertAt = lines.length;
    }
  }

  if (sectionStart < 0) {
    const prefix = lines.length && lines[lines.length - 1].trim() ? [""] : [];
    return [...lines, ...prefix, `[${section}]`, `${key}=${value}`].join("\r\n");
  }

  for (let i = sectionStart + 1; i < insertAt; i += 1) {
    const keyMatch = lines[i].match(/^\s*([^=]+?)\s*=/);
    if (keyMatch && keyMatch[1].trim().toLowerCase() === key.toLowerCase()) {
      lines[i] = `${key}=${value}`;
      return lines.join("\r\n");
    }
  }

  lines.splice(insertAt, 0, `${key}=${value}`);
  return lines.join("\r\n");
}

function buildClientConfig(settings = {}) {
  const width = Number(settings.width) || 1920;
  const height = Number(settings.height) || 1080;
  const borderless = settings.borderless ? "1" : "0";
  const windowed = settings.windowed === undefined ? "0" : (settings.windowed ? "1" : "0");

  return [
    "[MapleClient]",
    "ClientExe=BrulunaMS_Windowed.exe",
    `Width=${width}`,
    `Height=${height}`,
    `Borderless=${borderless}`,
    `Windowed=${windowed}`,
    ""
  ].join("\r\n");
}

async function listClientExecutables(root = portableClientDir(), current = portableClientDir(), results = []) {
  let entries;
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name === ".patch" || entry.name === ".launcher") continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await listClientExecutables(root, absolute, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".exe")) {
      results.push(path.relative(root, absolute).replace(/\\/g, "/"));
    }
  }

  return results.sort((a, b) => a.localeCompare(b));
}

async function getLauncherSettings() {
  const configPath = clientConfigPath();
  if (!(await pathExists(configPath))) {
    throw new Error("Please install the client first before changing play settings.");
  }

  const text = await fsp.readFile(configPath, "utf8");
  const clientExe = readIniValue(text, "MapleClient", "ClientExe") || "BrulunaMS_Windowed.exe";
  const width = Number(readIniValue(text, "MapleClient", "Width")) || 1920;
  const height = Number(readIniValue(text, "MapleClient", "Height")) || 1080;
  const readBool = (key, fallback = false) => {
    const value = readIniValue(text, "MapleClient", key);
    if (!value) return fallback;
    return value === "1" || /^true$/i.test(value);
  };

  return {
    clientDir: portableClientDir(),
    configPath,
    displayMode: readBool("Windowed", false) ? "windowed" : "fullscreen",
    width,
    height,
    borderless: readBool("Borderless")
  };
}

async function saveLauncherSettings(settings) {
  const configPath = clientConfigPath();
  if (!(await pathExists(configPath))) {
    throw new Error("Please install the client first before changing play settings.");
  }

  const width = Number(settings?.width) || 1920;
  const height = Number(settings?.height) || 1080;
  const allowedResolutions = new Set(["800x600", "1920x1080"]);
  if (!allowedResolutions.has(`${width}x${height}`)) {
    throw new Error("Please choose one of the listed resolutions.");
  }

  const text = buildClientConfig({
    width,
    height,
    borderless: Boolean(settings?.borderless),
    windowed: settings?.displayMode !== "fullscreen"
  });

  await fsp.writeFile(configPath, text, "ascii");
  return getLauncherSettings();
}

async function requestLauncherLoginTicket() {
  if (!config.LAUNCHER_LOGIN_TICKET_URL) {
    throw new Error("Launcher auto-login ticket endpoint is not configured.");
  }
  const selected = accountSession.accounts.find((account) => account.id === accountSession.selectedAccountId);
  if (!selected?.name) {
    throw new Error("Select one of your accounts before pressing Play.");
  }
  if (!accountSession.cookieHeader) {
    throw new Error("Please log in again before pressing Play.");
  }

  validateTicketEndpoint(config.LAUNCHER_LOGIN_TICKET_URL);
  let payload;
  try {
    payload = await fetchAuthJson(config.LAUNCHER_LOGIN_TICKET_URL, {
      method: "POST",
      headers: {
        Cookie: accountSession.cookieHeader
      },
      body: JSON.stringify({ account: selected.name })
    });
  } catch (error) {
    if (/Could not create launcher login ticket\.?$/i.test(error?.message || "")) {
      throw new Error("Login ticket server is still running old code. Restart the Login Server, then press Play again.");
    }
    throw error;
  }
  const ticket = firstString(payload?.ticket, payload?.data?.ticket);
  const account = firstString(payload?.account, payload?.data?.account, selected.name);
  if (!ticket || !account) {
    throw new Error("Login ticket service returned an invalid response.");
  }
  return { account, ticket };
}

async function launchGame(loginTicket = null) {
  await ensureDefaultClientConfig();
  const gameExeName = config.GAME_EXE_NAME;
  const clientDir = portableClientDir();
  const command = path.join(clientDir, gameExeName);
  if (!(await pathExists(command))) {
    throw new Error(`${gameExeName} is missing from ${clientDir}.`);
  }

  emitStatus("Starting game");
  await logLine("launching game executable", {
    isPackaged: app.isPackaged,
    clientDir,
    gameExeName,
    command,
    args: config.GAME_LAUNCH_ARGS
  });
  await new Promise((resolve, reject) => {
    const child = childProcess.spawn(command, config.GAME_LAUNCH_ARGS, {
      cwd: clientDir,
      env: createLoginEnvironment(process.env, loginTicket),
      detached: true,
      stdio: "ignore",
      windowsHide: false
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  emitStatus("Game running");
}

async function play() {
  if (LAUNCHER_AUTO_LOGIN_ENABLED && !accountSession.selectedAccountId) {
    throw new Error("Select one of your accounts before pressing Play.");
  }
  if (await ensureLauncherIsCurrent()) return { ok: true, launcherUpdate: true };
  const updateInfo = await checkUpdates();
  if (!updateInfo.ready) {
    emitStatus("Update available", `${updateInfo.changed.length} files`);
    await applyUpdates(updateInfo);
  }
  emitStatus("Client is ready");
  let loginTicket = null;
  if (LAUNCHER_AUTO_LOGIN_ENABLED) {
    emitStatus("Preparing auto-login");
    loginTicket = await requestLauncherLoginTicket();
  }
  await launchGame(loginTicket);
  return { ok: true };
}

async function repair() {
  if (await ensureLauncherIsCurrent()) return { ok: true, launcherUpdate: true, changed: 0 };
  const updateInfo = await checkUpdates(true);
  if (!updateInfo.ready) {
    emitStatus("Update available", `${updateInfo.changed.length} files`);
    await applyUpdates(updateInfo);
  }
  emitStatus("Client is ready");
  return { ok: true, changed: updateInfo.changed.length };
}

async function pingPatchServer() {
  const host = patchHostName();
  const checks = [];

  try {
    const response = await fetch(`${patchBaseUrl()}/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    checks.push({ name: "Patch", port: config.PATCH_PORT, online: true });
  } catch {
    checks.push({ name: "Patch", port: config.PATCH_PORT, online: false });
  }

  const serviceChecks = await Promise.all(
    (config.LIVE_STATUS_SERVICES || []).map(async (service) => ({
      ...service,
      online: await checkTcpPort(host, service.port)
    }))
  );
  checks.push(...serviceChecks);

  const requiredNames = new Set(
    (config.LIVE_STATUS_REQUIRED_SERVICES || [])
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const requiredChecks = requiredNames.size
    ? checks.filter((service) => requiredNames.has(String(service.name || "").toLowerCase()))
    : checks.filter((service) => service.name !== "Patch");
  const offline = checks.filter((service) => !service.online);
  const requiredOffline = requiredChecks.filter((service) => !service.online);
  return {
    online: requiredChecks.length > 0 && requiredOffline.length === 0,
    host,
    services: checks,
    offline: offline.map((service) => service.name),
    requiredOffline: requiredOffline.map((service) => service.name)
  };
}

function parseVersionParts(version) {
  return String(version || "")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function isVersionNewer(latest, current) {
  const latestParts = parseVersionParts(latest);
  const currentParts = parseVersionParts(current);
  const length = Math.max(latestParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const latestPart = latestParts[index] || 0;
    const currentPart = currentParts[index] || 0;
    if (latestPart > currentPart) return true;
    if (latestPart < currentPart) return false;
  }
  return false;
}

async function getLatestLauncherVersion() {
  const latestUrl = `${patchBaseUrl()}/launcher/latest.yml?ts=${Date.now()}`;
  const response = await fetch(latestUrl, {
    cache: "no-store",
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache"
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for launcher latest.yml`);
  const text = await response.text();
  const match = text.match(/^version:\s*['"]?([^'"\r\n]+)['"]?/m);
  return match ? match[1].trim() : null;
}

function launcherUpdaterCacheCandidates() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA
    || process.env.LocalAppData
    || process.env.localappdata;
  const updaterNames = [
    "brulunams-launcher-updater",
    "BrulunaMS Launcher-updater",
    `${app.getName()}-updater`
  ];

  if (localAppData) {
    for (const updaterName of updaterNames) {
      candidates.push(path.join(localAppData, updaterName));
    }
  }

  try {
    const userDataParent = path.dirname(app.getPath("userData"));
    for (const updaterName of updaterNames) {
      candidates.push(path.join(userDataParent, updaterName));
    }
  } catch {
    // Ignore unavailable userData paths during very early startup.
  }

  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
}

async function clearLauncherUpdaterCache(latestVersion) {
  const removed = [];
  for (const candidate of launcherUpdaterCacheCandidates()) {
    try {
      await fsp.rm(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } catch (error) {
      await logLine("launcher updater cache cleanup failed", {
        latestVersion,
        path: candidate,
        error: serializeError(error)
      });
    }
  }

  if (removed.length > 0) {
    await logLine("launcher updater cache cleared", {
      currentVersion: app.getVersion(),
      latestVersion,
      removed
    });
  }
}

async function ensureLauncherIsCurrent() {
  if (!app.isPackaged) return;
  const latestVersion = await getLatestLauncherVersion();
  if (latestVersion && isVersionNewer(latestVersion, app.getVersion())) {
    await installLauncherUpdate(latestVersion);
    return true;
  }
  return false;
}

async function installLauncherUpdate(latestVersion) {
  if (launcherSelfUpdateInstalling) return true;
  if (!launcherSelfUpdatePromise) {
    launcherSelfUpdatePromise = (async () => {
      launcherSelfUpdateInstalling = true;
      await beginLauncherUpdateUi(`Preparing launcher ${latestVersion}...`);
      emitStatus("Updating launcher", `Downloading launcher ${latestVersion}`);
      emitProgress({ phase: "LauncherDownloading", downloaded: 0, total: 0, percent: 0 });
      await logLine("launcher self-update start", {
        currentVersion: app.getVersion(),
        latestVersion,
        feedUrl: `${patchBaseUrl()}/launcher`
      });
      await clearLauncherUpdaterCache(latestVersion);

      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.requestHeaders = {
        "Cache-Control": "no-cache",
        Pragma: "no-cache"
      };
      autoUpdater.setFeedURL({
        provider: "generic",
        url: `${patchBaseUrl()}/launcher`
      });

      const result = await autoUpdater.checkForUpdates();
      if (result?.downloadPromise) {
        await result.downloadPromise;
      }

      emitStatus("Restarting launcher", "Installing launcher update");
      emitProgress({ phase: "LauncherInstalling", applied: 1, total: 1 });
      updateLauncherUpdateProgress({ phase: "LauncherInstalling", percent: 100 });
      await logLine("launcher self-update installing", {
        currentVersion: app.getVersion(),
        latestVersion
      });

      setTimeout(() => autoUpdater.quitAndInstall(true, true), 600);
      return true;
    })().catch(async (error) => {
      launcherSelfUpdateInstalling = false;
      launcherSelfUpdatePromise = null;
      await logLine("launcher self-update failed", {
        currentVersion: app.getVersion(),
        latestVersion,
        error: serializeError(error)
      });
      throw error;
    });
  }

  return launcherSelfUpdatePromise;
}

function setupLauncherAutoUpdater() {
  if (!app.isPackaged || launcherAutoUpdaterConfigured) return;
  launcherAutoUpdaterConfigured = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.requestHeaders = {
    "Cache-Control": "no-cache",
    Pragma: "no-cache"
  };
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `${patchBaseUrl()}/launcher`
  });

  autoUpdater.on("download-progress", (progress) => {
    const total = progress.total || 0;
    const downloaded = progress.transferred || 0;
    const launcherProgress = {
      phase: "LauncherDownloading",
      downloaded,
      total,
      percent: progress.percent || (total ? (downloaded / total) * 100 : 0)
    };
    emitProgress(launcherProgress);
    updateLauncherUpdateProgress(launcherProgress);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    if (launcherSelfUpdateInstalling) return;
    launcherSelfUpdateInstalling = true;
    await beginLauncherUpdateUi(`Installing launcher ${info?.version || ""}...`);
    emitStatus("Restarting launcher", "Installing launcher update");
    emitProgress({ phase: "LauncherInstalling", applied: 1, total: 1 });
    updateLauncherUpdateProgress({ phase: "LauncherInstalling", percent: 100 });
    await logLine("launcher background update installing", {
      currentVersion: app.getVersion(),
      latestVersion: info?.version
    });
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 600);
  });
}

function startLauncherAutoUpdateChecks() {
  if (!app.isPackaged) return;

  const runCheck = async () => {
    try {
      await ensureLauncherIsCurrent();
    } catch (error) {
      await logLine("launcher self-update check failed", {
        currentVersion: app.getVersion(),
        error: serializeError(error)
      });
    }
  };

  setTimeout(runCheck, 1200);
  setInterval(runCheck, 30 * 60 * 1000);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1280,
    minHeight: 720,
    resizable: false,
    maximizable: false,
    title: config.GAME_NAME,
    frame: false,
    titleBarStyle: "hidden",
    transparent: true,
    backgroundColor: "#00000000",
    icon: path.join(__dirname, "..", "assets", "icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await mainWindow.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("launcher:getState", async () => ({
  gameName: config.GAME_NAME,
  gameExe: config.GAME_EXE_NAME,
  patchBaseUrl: patchBaseUrl(),
  clientDir: portableClientDir(),
  logPath: launcherLogPath(),
  visibleLogPath: visibleLauncherLogPath(),
  launcherVersion: app.getVersion(),
  statusPollMs: config.STATUS_POLL_MS,
  progress: currentProgress,
  accountSession: publicAccountSession(),
  server: await pingPatchServer()
}));

ipcMain.handle("launcher:check", async (_event, options = {}) => checkUpdates(Boolean(options.forceFullVerify)));
ipcMain.handle("launcher:repair", async () => repair());
ipcMain.handle("launcher:play", async () => play());
ipcMain.handle("launcher:ping", async () => pingPatchServer());
ipcMain.handle("launcher:getRankings", async () => fetchRankings());
ipcMain.handle("launcher:getAccountSession", async () => publicAccountSession());
ipcMain.handle("launcher:loginAccount", async (_event, credentials) => {
  try {
    return { ok: true, session: await loginAccount(credentials) };
  } catch (error) {
    await logLine("launcher account login failed", { error: serializeError(error) });
    return { ok: false, error: publicAuthError(error, credentials?.username) };
  }
});
ipcMain.handle("launcher:selectAccount", async (_event, accountId) => selectLauncherAccount(accountId));
ipcMain.handle("launcher:logoutAccount", async () => logoutAccount());
ipcMain.handle("launcher:getSettings", async () => getLauncherSettings());
ipcMain.handle("launcher:saveSettings", async (_event, settings) => saveLauncherSettings(settings));
ipcMain.handle("launcher:openInstallDirectory", async () => {
  const installDir = app.isPackaged ? path.dirname(app.getPath("exe")) : app.getAppPath();
  const openError = await shell.openPath(installDir);
  if (openError) throw new Error(openError);
  return { ok: true, path: installDir };
});
ipcMain.handle("launcher:openDonate", async () => {
  await shell.openExternal(config.DONATE_URL || DISCORD_INVITE_URL);
  return { ok: true };
});
ipcMain.handle("launcher:openDiscord", async () => {
  await shell.openExternal(DISCORD_INVITE_URL);
  return { ok: true };
});
ipcMain.handle("launcher:openPasswordRecovery", async () => {
  await shell.openExternal(config.PASSWORD_RECOVERY_URL);
  return { ok: true };
});
ipcMain.handle("launcher:openRegister", async () => {
  await shell.openExternal(config.REGISTER_URL);
  return { ok: true };
});
ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:close", () => mainWindow?.close());
ipcMain.handle("window:startDrag", (_event, point) => {
  if (!mainWindow) return;
  dragState = {
    startX: point.screenX,
    startY: point.screenY,
    bounds: mainWindow.getBounds()
  };
});
ipcMain.handle("window:dragMove", (_event, point) => {
  if (!mainWindow || !dragState) return;
  const nextX = dragState.bounds.x + Math.round(point.screenX - dragState.startX);
  const nextY = dragState.bounds.y + Math.round(point.screenY - dragState.startY);
  mainWindow.setPosition(nextX, nextY, false);
});
ipcMain.handle("window:endDrag", () => {
  dragState = null;
});

const singleInstanceLock = app.requestSingleInstanceLock();
if (!singleInstanceLock) {
  app.quit();
}

if (singleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    await selectPatchBaseUrl();
    await createWindow();
    setupLauncherAutoUpdater();
    startLauncherAutoUpdateChecks();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
