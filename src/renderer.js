const serverPill = document.querySelector("#serverPill");
const playButton = document.querySelector("#playButton");
const repairButton = document.querySelector("#repairButton");
const statusLabel = document.querySelector("#statusLabel");
const versionLabel = document.querySelector("#versionLabel");
const progressLabel = document.querySelector("#progressLabel");
const separatorProgressFill = document.querySelector("#separatorProgressFill");
const separatorProgressSpark = document.querySelector("#separatorProgressSpark");
const errorBox = document.querySelector("#errorBox");
const patchUrl = document.querySelector("#patchUrl");
const clientDir = document.querySelector("#clientDir");
const gameName = document.querySelector("#gameName");
const statusCard = document.querySelector(".status-card");
const serverText = document.querySelector("#serverText");
const minimizeButton = document.querySelector("#minimizeButton");
const closeButton = document.querySelector("#closeButton");
const settingsButton = document.querySelector("#settingsButton");
const settingsDialog = document.querySelector("#settingsDialog");
const settingsCloseButton = document.querySelector("#settingsCloseButton");
const settingsCancelButton = document.querySelector("#settingsCancelButton");
const settingsSaveButton = document.querySelector("#settingsSaveButton");
const displayModeInput = document.querySelector("#displayModeInput");
const resolutionInput = document.querySelector("#resolutionInput");
const borderlessInput = document.querySelector("#borderlessInput");
const scaleToScreenInput = document.querySelector("#scaleToScreenInput");
const mobOverlayInput = document.querySelector("#mobOverlayInput");
const textShortcutsInput = document.querySelector("#textShortcutsInput");
const spaceNpcInput = document.querySelector("#spaceNpcInput");
const autoFlashJumpInput = document.querySelector("#autoFlashJumpInput");
const settingsPath = document.querySelector("#settingsPath");
const navItems = document.querySelectorAll(".nav-item");
const titlebar = document.querySelector(".titlebar");
let draggingWindow = false;
let launcherVersion = "";
let errorTimer = null;

document.addEventListener("dragstart", (event) => event.preventDefault());
document.addEventListener("selectstart", (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
});

function setBusy(isBusy) {
  playButton.disabled = isBusy;
  repairButton.disabled = isBusy;
}

function friendlyError(error) {
  const message = typeof error === "string" ? error : error?.message || "";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|Failed to fetch|HTTP 5\d\d/i.test(message)) {
    return "Server is not online, try again later.";
  }
  if (/UNKNOWN: unknown error, open|EPERM|EACCES|EBUSY/i.test(message)) {
    return "Windows blocked the launcher from writing update files. Close the game and launcher, then reopen the launcher as administrator. If it still happens, send %LOCALAPPDATA%\\BrulunaMS Launcher\\launcher.log.";
  }

  return message
    .replace(/^Error invoking remote method 'launcher:[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    || "Something went wrong. Please try again.";
}

function setError(message) {
  window.clearTimeout(errorTimer);
  errorBox.classList.remove("is-visible");

  if (!message) {
    errorBox.hidden = true;
    errorBox.textContent = "";
    return;
  }

  errorBox.textContent = message;
  errorBox.hidden = false;
  requestAnimationFrame(() => errorBox.classList.add("is-visible"));
  errorTimer = window.setTimeout(() => {
    errorBox.classList.remove("is-visible");
    window.setTimeout(() => {
      if (!errorBox.classList.contains("is-visible")) {
        errorBox.hidden = true;
        errorBox.textContent = "";
      }
    }, 260);
  }, 5200);
}

function setServer(online) {
  serverPill.textContent = online ? "LIVE" : "OFFLINE";
  statusCard.classList.toggle("online", online);
  statusCard.classList.toggle("offline", !online);
  serverText.textContent = online ? "Online & accepting adventurers!" : "Patch server unavailable.";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function setProgress(progress) {
  if (!progress) return;
  if (progress.phase === "Downloading" || progress.phase === "LauncherDownloading") {
    const percent = Math.min(100, progress.percent ?? (progress.total ? (progress.downloaded / progress.total) * 100 : 0));
    separatorProgressFill.style.width = `${percent}%`;
    separatorProgressSpark.style.left = `${percent}%`;
    separatorProgressSpark.hidden = percent <= 0 || percent >= 100;
    const bytes = progress.total ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}` : `${Math.round(percent)}%`;
    progressLabel.textContent = progress.phase === "LauncherDownloading"
      ? `Downloading launcher ${Math.round(percent)}% - ${bytes}`
      : `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`;
    return;
  }

  if (progress.phase === "Installing" || progress.phase === "LauncherInstalling") {
    const percent = progress.total ? Math.min(100, (progress.applied / progress.total) * 100) : 100;
    separatorProgressFill.style.width = `${percent}%`;
    separatorProgressSpark.style.left = `${percent}%`;
    separatorProgressSpark.hidden = percent <= 0 || percent >= 100;
    progressLabel.textContent = progress.phase === "LauncherInstalling" ? "Installing launcher update" : "Applying files";
  }
}

function resetProgressBar() {
  separatorProgressFill.style.width = "0%";
  separatorProgressSpark.style.left = "0%";
  separatorProgressSpark.hidden = true;
}

function completeProgressBar() {
  separatorProgressFill.style.width = "100%";
  separatorProgressSpark.hidden = true;
}

async function refreshServer() {
  const result = await window.launcher.ping();
  setServer(result.online);
}

async function loadNews(baseUrl) {
  try {
    const latest = await fetch(`${baseUrl}/latest.json`, { cache: "no-store" }).then((response) => response.json());
    versionLabel.textContent = latest.gameVersion ? `Client v${latest.gameVersion}` : `Launcher v${launcherVersion}`;
    if (!latest.newsUrl) return;
    const news = await fetch(`${baseUrl}${latest.newsUrl}`, { cache: "no-store" }).then((response) => response.json());
    const items = Array.isArray(news.items) ? news.items : [];
    if (!items.length) return;
    const first = items[0];
    progressLabel.textContent = first.body || "Click to verify and repair files";
  } catch {
    // News is optional; the patch flow should stay quiet if it is not published yet.
    versionLabel.textContent = launcherVersion ? `Launcher v${launcherVersion}` : "Client version unavailable";
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function repair() {
  setBusy(true);
  setError("");
  statusLabel.textContent = "Repairing";
  progressLabel.textContent = "Verifying client files";
  resetProgressBar();

  try {
    const result = await window.launcher.repair();
    if (result.launcherUpdate) {
      statusLabel.textContent = "Updating launcher";
      progressLabel.textContent = "Restarting to install launcher update";
      return;
    }
    statusLabel.textContent = "Client is ready";
    progressLabel.textContent = result.changed ? `Repaired ${result.changed} files` : "No changes needed";
    completeProgressBar();
  } catch (error) {
    statusLabel.textContent = "Repair failed";
    setError(friendlyError(error));
  } finally {
    setBusy(false);
  }
}

async function play() {
  setBusy(true);
  setError("");
  resetProgressBar();

  try {
    const result = await window.launcher.play();
    if (result?.launcherUpdate) {
      statusLabel.textContent = "Updating launcher";
      progressLabel.textContent = "Restarting to install launcher update";
    }
  } catch (error) {
    statusLabel.textContent = "Launch failed";
    setError(friendlyError(error));
  } finally {
    setBusy(false);
  }
}

async function openSettings() {
  setError("");
  settingsDialog.hidden = false;
  setSettingsFormEnabled(false);
  settingsPath.textContent = "Loading client settings...";

  try {
    const settings = await window.launcher.getSettings();
    populateSettingsForm(settings);
    settingsPath.textContent = `Saved in ${settings.configPath}`;
    setSettingsFormEnabled(true);
  } catch (error) {
    settingsPath.textContent = friendlyError(error);
    setSettingsFormEnabled(false);
  }
}

function closeSettings() {
  settingsDialog.hidden = true;
}

function setSettingsFormEnabled(enabled) {
  for (const input of [
    displayModeInput,
    resolutionInput,
    borderlessInput,
    scaleToScreenInput,
    mobOverlayInput,
    textShortcutsInput,
    spaceNpcInput,
    autoFlashJumpInput,
    settingsSaveButton
  ]) {
    input.disabled = !enabled;
  }
}

function populateSettingsForm(settings) {
  displayModeInput.value = settings.displayMode || "windowed";
  resolutionInput.value = `${settings.width || 800}x${settings.height || 600}`;
  borderlessInput.checked = Boolean(settings.borderless);
  scaleToScreenInput.checked = Boolean(settings.scaleToScreen);
  mobOverlayInput.checked = Boolean(settings.mobLevelNameOverlay);
  textShortcutsInput.checked = Boolean(settings.textInputShortcuts);
  spaceNpcInput.checked = Boolean(settings.npcDialogSpaceNext);
  autoFlashJumpInput.checked = Boolean(settings.autoFlashJump);
}

async function saveSettings() {
  settingsSaveButton.disabled = true;
  const [width, height] = resolutionInput.value.split("x").map((value) => Number(value));
  try {
    const settings = await window.launcher.saveSettings({
      displayMode: displayModeInput.value,
      width,
      height,
      borderless: borderlessInput.checked,
      scaleToScreen: scaleToScreenInput.checked,
      mobLevelNameOverlay: mobOverlayInput.checked,
      textInputShortcuts: textShortcutsInput.checked,
      npcDialogSpaceNext: spaceNpcInput.checked,
      autoFlashJump: autoFlashJumpInput.checked
    });
    settingsPath.textContent = `Saved to ${settings.configPath}`;
    closeSettings();
  } catch (error) {
    settingsPath.textContent = friendlyError(error);
  } finally {
    settingsSaveButton.disabled = false;
  }
}

window.launcher.onStatus(({ status, detail }) => {
  statusLabel.textContent = status;
  if (detail) progressLabel.textContent = detail;
  if (status === "Client is ready" || status === "Game running") {
    separatorProgressSpark.hidden = true;
  }
});

window.launcher.onProgress(setProgress);

playButton.addEventListener("click", play);
repairButton.addEventListener("click", repair);
minimizeButton.addEventListener("click", () => window.launcher.minimize());
closeButton.addEventListener("click", () => window.launcher.close());
settingsButton.addEventListener("click", openSettings);
settingsCloseButton.addEventListener("click", closeSettings);
settingsCancelButton.addEventListener("click", closeSettings);
settingsSaveButton.addEventListener("click", saveSettings);
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) closeSettings();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingsDialog.hidden) closeSettings();
});
function spawnClickSparkles(event) {
  const root = document.createElement("div");
  root.className = "click-sparkles";
  root.style.left = `${event.clientX}px`;
  root.style.top = `${event.clientY}px`;

  for (let index = 0; index < 8; index += 1) {
    const sparkle = document.createElement("span");
    const angle = (Math.PI * 2 * index) / 8 + (Math.random() - 0.5) * 0.55;
    const distance = 34 + Math.random() * 46;
    sparkle.style.setProperty("--tx", `${Math.cos(angle) * distance}px`);
    sparkle.style.setProperty("--ty", `${Math.sin(angle) * distance}px`);
    sparkle.style.setProperty("--delay", `${Math.random() * 55}ms`);
    sparkle.style.setProperty("--scale", `${0.72 + Math.random() * 0.72}`);
    root.appendChild(sparkle);
  }

  document.body.appendChild(root);
  window.setTimeout(() => root.remove(), 780);
}

window.addEventListener("pointerdown", spawnClickSparkles);
titlebar.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".window-controls")) return;
  draggingWindow = true;
  titlebar.setPointerCapture(event.pointerId);
  window.launcher.startWindowDrag({ screenX: event.screenX, screenY: event.screenY });
});
titlebar.addEventListener("pointermove", (event) => {
  if (!draggingWindow) return;
  window.launcher.moveWindowDrag({ screenX: event.screenX, screenY: event.screenY });
});
function endWindowDrag(event) {
  if (!draggingWindow) return;
  draggingWindow = false;
  if (event && titlebar.hasPointerCapture(event.pointerId)) {
    titlebar.releasePointerCapture(event.pointerId);
  }
  window.launcher.endWindowDrag();
}
titlebar.addEventListener("pointerup", endWindowDrag);
titlebar.addEventListener("pointercancel", endWindowDrag);
titlebar.addEventListener("lostpointercapture", () => {
  if (draggingWindow) {
    draggingWindow = false;
    window.launcher.endWindowDrag();
  }
});
for (const item of navItems) {
  item.addEventListener("click", () => {
    navItems.forEach((navItem) => navItem.classList.remove("active"));
    item.classList.add("active");
  });
}

window.launcher.getState().then((state) => {
  launcherVersion = state.launcherVersion || "";
  if (gameName) gameName.textContent = state.gameName;
  clientDir.textContent = state.clientDir;
  patchUrl.textContent = state.patchBaseUrl;
  versionLabel.textContent = launcherVersion ? `Launcher v${launcherVersion}` : "Checking client version...";
  setServer(state.server.online);
  loadNews(state.patchBaseUrl);
});

refreshServer();
setInterval(refreshServer, 15000);
