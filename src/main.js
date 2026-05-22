const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const config = require("./config");

let mainWindow;
let currentProgress = null;
let dragState = null;
let launcherSelfUpdatePromise = null;
let launcherSelfUpdateInstalling = false;
let selectedClientDir = null;
let selectedClientDirReason = null;
let activePatchBaseUrl = String(config.PUBLIC_PATCH_BASE_URL || "").replace(/\/+$/, "");

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

function canWriteClientDir(clientDir) {
  try {
    const launcherDir = path.join(clientDir, ".launcher");
    fs.mkdirSync(launcherDir, { recursive: true });
    const probePath = path.join(launcherDir, `write-probe-${process.pid}.tmp`);
    fs.writeFileSync(probePath, "ok");
    fs.rmSync(probePath, { force: true });
    return true;
  } catch {
    return false;
  }
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
  if (!app.isPackaged) return path.join(launcherWritableRoot(), "Client");
  if (selectedClientDir) return selectedClientDir;

  const installClientDir = installedClientDir();
  if (canWriteClientDir(installClientDir)) {
    selectedClientDir = installClientDir;
    selectedClientDirReason = "installed client folder is writable";
    return selectedClientDir;
  }

  selectedClientDir = path.join(launcherWritableRoot(), "Client");
  selectedClientDirReason = "installed client folder is not writable";
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
  const latest = await getLatest();
  const state = await readInstallState();

  if (!forceFullVerify && state && state.manifestSha256 === latest.manifestSha256) {
    const manifest = await getManifest(latest);
    const criticalNames = new Set([
      config.GAME_EXE_NAME.toLowerCase(),
      "brulunams.dll",
      "brulunams_windowed.exe",
      "brulunams_fullscreen.exe",
      "mapleclientmod.dll"
    ]);
    const manifestFiles = (manifest.files || [])
      .map((file) => ({ ...file, path: normalizeManifestPath(file.path) }));
    const changed = [];
    let totalBytes = 0;

    for (const file of manifestFiles) {
      if (await shouldPreserveExistingFile(file.path, false)) {
        continue;
      }

      const localPath = path.join(portableClientDir(), file.path);
      let needsUpdate = true;
      try {
        const stat = await fsp.stat(localPath);
        needsUpdate = stat.size !== file.size;
        if (!needsUpdate && criticalNames.has(path.basename(file.path).toLowerCase())) {
          needsUpdate = (await sha256File(localPath)) !== file.sha256;
        }
      } catch {
        needsUpdate = true;
      }

      if (needsUpdate) {
        changed.push(file);
        totalBytes += file.size || 0;
      }
    }

    return {
      ready: changed.length === 0,
      latest,
      manifest,
      changed,
      deletions: [],
      totalBytes,
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

async function isGameRunning() {
  const exeNames = [
    config.GAME_EXE_NAME,
    "BrulunaMS_Windowed.exe",
    "BrulunaMS_Fullscreen.exe"
  ];
  return new Promise((resolve) => {
    childProcess.execFile("tasklist.exe", ["/FO", "CSV"], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(false);
      const lower = stdout.toLowerCase();
      resolve(exeNames.some((exeName) => lower.includes(`"${exeName.toLowerCase()}"`)));
    });
  });
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
  if (await isGameRunning()) {
    throw new Error(`${config.GAME_EXE_NAME} is running. Close the game before patching.`);
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

  const defaultConfig = [
    "[MapleClient]",
    "ClientExe=BrulunaMS_Windowed.exe",
    "Width=800",
    "Height=600",
    "Borderless=0",
    "Windowed=1",
    "ScaleToScreen=0",
    "ServerHost=lobbyx3.serveminecraft.net",
    "MobLevelNameOverlay=1",
    "TextInputShortcuts=1",
    "AutoFlashJump=1",
    "NpcDialogSpaceNext=1",
    "AutoFlashJumpJumpVk=18",
    "AutoFlashJumpSkillScan=87",
    "AutoFlashJumpWindowMs=450",
    "AutoFlashJumpHoldMs=70",
    "AutoFlashJumpDelayMs=20",
    ""
  ].join("\r\n");

  await fsp.writeFile(configPath, defaultConfig);
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
  const width = Number(readIniValue(text, "MapleClient", "Width")) || 800;
  const height = Number(readIniValue(text, "MapleClient", "Height")) || 600;
  const readBool = (key, fallback = false) => {
    const value = readIniValue(text, "MapleClient", key);
    if (!value) return fallback;
    return value === "1" || /^true$/i.test(value);
  };

  return {
    clientDir: portableClientDir(),
    configPath,
    displayMode: clientExe.toLowerCase().includes("fullscreen") ? "fullscreen" : "windowed",
    width,
    height,
    borderless: readBool("Borderless"),
    scaleToScreen: readBool("ScaleToScreen"),
    mobLevelNameOverlay: readBool("MobLevelNameOverlay", true),
    textInputShortcuts: readBool("TextInputShortcuts", true),
    npcDialogSpaceNext: readBool("NpcDialogSpaceNext", true),
    autoFlashJump: readBool("AutoFlashJump", true)
  };
}

async function saveLauncherSettings(settings) {
  const configPath = clientConfigPath();
  if (!(await pathExists(configPath))) {
    throw new Error("Please install the client first before changing play settings.");
  }

  const width = Number(settings?.width) || 800;
  const height = Number(settings?.height) || 600;
  const allowedResolutions = new Set(["800x600", "1024x768", "1280x720", "1366x768", "1600x900", "1920x1080"]);
  if (!allowedResolutions.has(`${width}x${height}`)) {
    throw new Error("Please choose one of the listed resolutions.");
  }

  const clientExe = settings?.displayMode === "fullscreen" ? "BrulunaMS_Fullscreen.exe" : "BrulunaMS_Windowed.exe";
  const boolValue = (value) => (value ? "1" : "0");

  let text = await fsp.readFile(configPath, "utf8");
  text = setIniValue(text, "MapleClient", "ClientExe", clientExe);
  text = setIniValue(text, "MapleClient", "Windowed", settings?.displayMode === "fullscreen" ? "0" : "1");
  text = setIniValue(text, "MapleClient", "Width", String(width));
  text = setIniValue(text, "MapleClient", "Height", String(height));
  text = setIniValue(text, "MapleClient", "Borderless", boolValue(settings?.borderless));
  text = setIniValue(text, "MapleClient", "ScaleToScreen", boolValue(settings?.scaleToScreen));
  text = setIniValue(text, "MapleClient", "MobLevelNameOverlay", boolValue(settings?.mobLevelNameOverlay));
  text = setIniValue(text, "MapleClient", "TextInputShortcuts", boolValue(settings?.textInputShortcuts));
  text = setIniValue(text, "MapleClient", "NpcDialogSpaceNext", boolValue(settings?.npcDialogSpaceNext));
  text = setIniValue(text, "MapleClient", "AutoFlashJump", boolValue(settings?.autoFlashJump));

  await fsp.writeFile(configPath, text);
  return getLauncherSettings();
}

async function launchGame() {
  await ensureDefaultClientConfig();
  const command = path.join(portableClientDir(), config.GAME_EXE_NAME);
  if (!(await pathExists(command))) {
    throw new Error(`${config.GAME_EXE_NAME} is missing from ${portableClientDir()}.`);
  }

  emitStatus("Starting game");
  if (config.GAME_LAUNCH_ARGS.length) {
    await new Promise((resolve, reject) => {
      const child = childProcess.spawn(command, config.GAME_LAUNCH_ARGS, {
        cwd: portableClientDir(),
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
  } else {
    const launchError = await shell.openPath(command);
    if (launchError) throw new Error(launchError);
  }
  emitStatus("Game running");
}

async function play() {
  if (await ensureLauncherIsCurrent()) return { ok: true, launcherUpdate: true };
  const updateInfo = await checkUpdates();
  if (!updateInfo.ready) {
    emitStatus("Update available", `${updateInfo.changed.length} files`);
    await applyUpdates(updateInfo);
  }
  emitStatus("Client is ready");
  await launchGame();
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
  try {
    const response = await fetch(`${patchBaseUrl()}/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { online: true };
  } catch {
    return { online: false };
  }
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
  const response = await fetch(`${patchBaseUrl()}/launcher/latest.yml`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for launcher latest.yml`);
  const text = await response.text();
  const match = text.match(/^version:\s*['"]?([^'"\r\n]+)['"]?/m);
  return match ? match[1].trim() : null;
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
      emitStatus("Updating launcher", `Downloading launcher ${latestVersion}`);
      emitProgress({ phase: "LauncherDownloading", downloaded: 0, total: 0, percent: 0 });
      await logLine("launcher self-update start", {
        currentVersion: app.getVersion(),
        latestVersion,
        feedUrl: `${patchBaseUrl()}/launcher`
      });

      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
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
      await logLine("launcher self-update installing", {
        currentVersion: app.getVersion(),
        latestVersion
      });

      setTimeout(() => autoUpdater.quitAndInstall(false, true), 600);
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
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `${patchBaseUrl()}/launcher`
  });

  autoUpdater.on("download-progress", (progress) => {
    const total = progress.total || 0;
    const downloaded = progress.transferred || 0;
    emitProgress({
      phase: "LauncherDownloading",
      downloaded,
      total,
      percent: progress.percent || (total ? (downloaded / total) * 100 : 0)
    });
  });

  autoUpdater.on("update-downloaded", async (info) => {
    if (launcherSelfUpdateInstalling) return;
    launcherSelfUpdateInstalling = true;
    await dialog.showMessageBox(mainWindow, {
      type: "info",
      buttons: ["Restart now"],
      defaultId: 0,
      title: "Launcher update ready",
      message: `Launcher version ${info.version} is ready to install.`,
      detail: "The launcher will restart to finish updating before patching the client."
    });

    autoUpdater.quitAndInstall(false, true);
  });

  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 810,
    minWidth: 1180,
    minHeight: 660,
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
  progress: currentProgress,
  server: await pingPatchServer()
}));

ipcMain.handle("launcher:check", async (_event, options = {}) => checkUpdates(Boolean(options.forceFullVerify)));
ipcMain.handle("launcher:repair", async () => repair());
ipcMain.handle("launcher:play", async () => play());
ipcMain.handle("launcher:ping", async () => pingPatchServer());
ipcMain.handle("launcher:getSettings", async () => getLauncherSettings());
ipcMain.handle("launcher:saveSettings", async (_event, settings) => saveLauncherSettings(settings));
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
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
