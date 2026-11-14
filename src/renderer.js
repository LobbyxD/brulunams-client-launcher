const serverPill = document.querySelector("#serverPill");
const playButton = document.querySelector("#playButton");
const repairButton = document.querySelector("#repairButton");
const statusLabel = document.querySelector("#statusLabel");
const versionLabel = document.querySelector("#versionLabel");
const launcherVersionLabel = document.querySelector("#launcherVersionLabel");
const progressLabel = document.querySelector("#progressLabel");
const separatorProgressFill = document.querySelector("#separatorProgressFill");
const separatorProgressSpark = document.querySelector(
  "#separatorProgressSpark",
);
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
const settingsOpenInstallButton = document.querySelector("#settingsOpenInstallButton");
const settingsCancelButton = document.querySelector("#settingsCancelButton");
const settingsSaveButton = document.querySelector("#settingsSaveButton");
const displayModeInput = document.querySelector("#displayModeInput");
const resolutionInput = document.querySelector("#resolutionInput");
const borderlessInput = document.querySelector("#borderlessInput");
const settingsPath = document.querySelector("#settingsPath");
const navItems = document.querySelectorAll(".nav-item");
const donateButton = document.querySelector(".nav-donate");
const discordButton = document.querySelector(".nav-discord");
const scrollDialog = document.querySelector("#scrollDialog");
const scrollTitle = document.querySelector("#scrollTitle");
const scrollBody = document.querySelector("#scrollBody");
const rankingsPodium = document.querySelector("#rankingsPodium");
const accountPanel = document.querySelector("#accountPanel");
const accountLoginForm = document.querySelector("#accountLoginForm");
const accountUsernameInput = document.querySelector("#accountUsernameInput");
const accountPasswordInput = document.querySelector("#accountPasswordInput");
const accountRememberInput = document.querySelector("#accountRememberInput");
const accountLoginButton = document.querySelector("#accountLoginButton");
const accountForgotButton = document.querySelector("#accountForgotButton");
const accountRegisterButton = document.querySelector("#accountRegisterButton");
const accountLogoutButton = document.querySelector("#accountLogoutButton");
const accountPicker = document.querySelector("#accountPicker");
const accountWelcome = document.querySelector("#accountWelcome");
const accountList = document.querySelector("#accountList");
const accountStatus = document.querySelector("#accountStatus");
const titlebar = document.querySelector(".titlebar");
let draggingWindow = false;
let launcherVersion = "";
let errorTimer = null;
let scrollCloseTimer = null;
let scrollFadeTimer = null;
let scrollFloatTimer = null;
let scrollTextTimer = null;
let activeScrollPanel = null;
let rankingsCache = null;
let rankingsLoading = false;
let serverRefreshInFlight = false;
let serverRefreshTimer = null;
let accountScrollPulseTimer = null;
let accountSession = {
  loggedIn: false,
  accounts: [],
  selectedAccountId: null,
  selectedAccount: null,
};
const REMEMBER_ACCOUNT_KEY = "brulunams.launcher.rememberAccount";
const REMEMBER_USERNAME_KEY = "brulunams.launcher.rememberUsername";
const ACCOUNT_LOGIN_ENABLED = true;

const SCROLL_PANELS = {
  news: {
    title: "Latest News",
    body: "FHD Client is now live!",
  },
  events: {
    title: "Events",
    body: "Limited-time festivals, bonuses, and community activities will appear here.",
  },
  rankings: {
    title: "Rankings",
    body: "Loading the top champions...",
  },
};

document.addEventListener("dragstart", (event) => event.preventDefault());
document.addEventListener("selectstart", (event) => {
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement
  )
    return;
  event.preventDefault();
});

function setBusy(isBusy) {
  playButton.disabled = isBusy || !canPlay();
  repairButton.disabled = isBusy;
}

function canPlay() {
  if (!ACCOUNT_LOGIN_ENABLED) return true;
  return Boolean(accountSession?.selectedAccountId);
}

function friendlyError(error) {
  const message = typeof error === "string" ? error : error?.message || "";
  if (
    /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|Failed to fetch|HTTP 5\d\d/i.test(
      message,
    )
  ) {
    return "Server is not online, try again later.";
  }
  if (/UNKNOWN: unknown error, open|EPERM|EACCES|EBUSY/i.test(message)) {
    return "Windows blocked the launcher from writing update files. Close the game and launcher, then reopen the launcher as administrator. If it still happens, send %LOCALAPPDATA%\\BrulunaMS Launcher\\launcher.log.";
  }

  return (
    message
      .replace(/^Error invoking remote method 'launcher:[^']+':\s*/i, "")
      .replace(/^Error:\s*/i, "") || "Something went wrong. Please try again."
  );
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

function setServer(status) {
  const online = typeof status === "boolean" ? status : Boolean(status?.online);
  serverPill.textContent = online ? "Online" : "Offline";
  statusCard.classList.toggle("online", online);
  statusCard.classList.toggle("offline", !online);
  serverText.textContent = online
    ? "Online & accepting adventurers!"
    : "Server is not online, try again later.";
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
  if (
    progress.phase === "Downloading" ||
    progress.phase === "LauncherDownloading"
  ) {
    const percent = Math.min(
      100,
      progress.percent ??
        (progress.total ? (progress.downloaded / progress.total) * 100 : 0),
    );
    separatorProgressFill.style.width = `${percent}%`;
    separatorProgressSpark.style.left = `${percent}%`;
    separatorProgressSpark.hidden = percent <= 0 || percent >= 100;
    const bytes = progress.total
      ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
      : `${Math.round(percent)}%`;
    progressLabel.textContent =
      progress.phase === "LauncherDownloading"
        ? `Downloading launcher ${Math.round(percent)}% - ${bytes}`
        : `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`;
    return;
  }

  if (
    progress.phase === "Installing" ||
    progress.phase === "LauncherInstalling"
  ) {
    const percent = progress.total
      ? Math.min(100, (progress.applied / progress.total) * 100)
      : 100;
    separatorProgressFill.style.width = `${percent}%`;
    separatorProgressSpark.style.left = `${percent}%`;
    separatorProgressSpark.hidden = percent <= 0 || percent >= 100;
    progressLabel.textContent =
      progress.phase === "LauncherInstalling"
        ? "Installing launcher update"
        : "Applying files";
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
  if (serverRefreshInFlight) return;
  serverRefreshInFlight = true;
  try {
    const result = await window.launcher.ping();
    setServer(result);
  } finally {
    serverRefreshInFlight = false;
  }
}

async function loadNews(baseUrl) {
  try {
    const latest = await fetch(`${baseUrl}/latest.json`, {
      cache: "no-store",
    }).then((response) => response.json());
    versionLabel.textContent = latest.gameVersion
      ? `Client v${latest.gameVersion}`
      : `Launcher v${launcherVersion}`;
    if (!latest.newsUrl) return;
    const news = await fetch(`${baseUrl}${latest.newsUrl}`, {
      cache: "no-store",
    }).then((response) => response.json());
    const items = Array.isArray(news.items) ? news.items : [];
    if (!items.length) return;
    const first = items[0];
    progressLabel.textContent =
      first.body || "Click to verify and repair files";
  } catch {
    // News is optional; the patch flow should stay quiet if it is not published yet.
    versionLabel.textContent = launcherVersion
      ? `Launcher v${launcherVersion}`
      : "Client version unavailable";
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
    progressLabel.textContent = result.changed
      ? `Repaired ${result.changed} files`
      : "No changes needed";
    completeProgressBar();
  } catch (error) {
    statusLabel.textContent = "Repair failed";
    setError(friendlyError(error));
  } finally {
    setBusy(false);
  }
}

async function play() {
  if (ACCOUNT_LOGIN_ENABLED && !canPlay()) {
    setError("Select one of your accounts before pressing Play.");
    return;
  }
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

function updatePlayAvailability() {
  playButton.disabled = !canPlay();
  playButton.classList.toggle("is-locked", !canPlay());
}

function loadRememberedAccount() {
  if (!accountRememberInput || !accountUsernameInput) return;
  const remember = localStorage.getItem(REMEMBER_ACCOUNT_KEY) === "1";
  accountRememberInput.checked = remember;
  if (remember) {
    accountUsernameInput.value = localStorage.getItem(REMEMBER_USERNAME_KEY) || "";
  }
}

function saveRememberedAccount() {
  if (!accountRememberInput || !accountUsernameInput) return;
  if (accountRememberInput.checked) {
    localStorage.setItem(REMEMBER_ACCOUNT_KEY, "1");
    localStorage.setItem(REMEMBER_USERNAME_KEY, accountUsernameInput.value.trim());
    return;
  }
  localStorage.removeItem(REMEMBER_ACCOUNT_KEY);
  localStorage.removeItem(REMEMBER_USERNAME_KEY);
}

function updateAccountScrollState() {
  if (!accountList) return;
  const overflow = accountList.scrollHeight > accountList.clientHeight + 1;
  const atTop = accountList.scrollTop <= 1;
  const atBottom = accountList.scrollTop + accountList.clientHeight >= accountList.scrollHeight - 1;

  accountList.classList.toggle("is-scrollable", overflow);
  accountList.classList.toggle("is-at-top", overflow && atTop);
  accountList.classList.toggle("is-at-bottom", overflow && atBottom);
}

function pulseAccountScrollEdge(edge) {
  if (!accountList) return;
  const className = edge === "top" ? "is-pulsing-top" : "is-pulsing-bottom";
  accountList.classList.remove(className);
  void accountList.offsetWidth;
  accountList.classList.add(className);
  window.clearTimeout(accountScrollPulseTimer);
  accountScrollPulseTimer = window.setTimeout(() => {
    accountList.classList.remove(className);
  }, 620);
}

function handleAccountListWheel(event) {
  if (!accountList) return;
  updateAccountScrollState();
  if (event.deltaY < 0 && accountList.classList.contains("is-at-top")) {
    pulseAccountScrollEdge("top");
  }
  if (event.deltaY > 0 && accountList.classList.contains("is-at-bottom")) {
    pulseAccountScrollEdge("bottom");
  }
}

function renderAccountSession(session) {
  if (!accountList || !accountLoginForm || !accountPicker || !accountLogoutButton || !accountStatus) {
    updatePlayAvailability();
    return;
  }
  accountSession = {
    loggedIn: Boolean(session?.loggedIn),
    user: session?.user || null,
    accounts: Array.isArray(session?.accounts) ? session.accounts : [],
    selectedAccountId: session?.selectedAccountId || null,
    selectedAccount: session?.selectedAccount || null,
  };

  accountList.replaceChildren();
  accountLoginForm.hidden = accountSession.loggedIn;
  accountPicker.hidden = !accountSession.loggedIn;
  accountLogoutButton.hidden = !accountSession.loggedIn;

  if (!accountSession.loggedIn) {
    accountStatus.textContent = "";
    updateAccountScrollState();
    updatePlayAvailability();
    return;
  }

  accountWelcome.textContent = accountSession.user?.name
    ? `Welcome, ${accountSession.user.name}`
    : "Welcome";

  if (!accountSession.accounts.length) {
    accountStatus.textContent = "No game accounts were found.";
    updateAccountScrollState();
    updatePlayAvailability();
    return;
  }

  for (const account of accountSession.accounts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "account-choice";
    button.classList.toggle("selected", account.id === accountSession.selectedAccountId);
    button.dataset.accountId = account.id;

    const name = document.createElement("strong");
    name.textContent = account.name;
    button.appendChild(name);

    if (account.meta) {
      const meta = document.createElement("span");
      meta.textContent = account.meta;
      button.appendChild(meta);
    }

    button.addEventListener("click", async () => {
      setError("");
      accountStatus.textContent = "Selecting account...";
      try {
        renderAccountSession(await window.launcher.selectAccount(account.id));
      } catch (error) {
        accountStatus.textContent = friendlyError(error);
        updatePlayAvailability();
      }
    });

    accountList.appendChild(button);
  }

  accountStatus.textContent = accountSession.selectedAccount
    ? `Selected Account: ${accountSession.selectedAccount.name}`
    : "Select an account to unlock Play.";
  requestAnimationFrame(updateAccountScrollState);
  updatePlayAvailability();
}

async function loginAccount(event) {
  if (!accountLoginButton || !accountUsernameInput || !accountPasswordInput || !accountStatus) return;
  event.preventDefault();
  setError("");
  accountLoginButton.disabled = true;
  const loginButtonText = accountLoginButton.textContent;
  accountLoginButton.textContent = "Logging in...";
  accountStatus.textContent = "";

  try {
    const result = await window.launcher.loginAccount({
      username: accountUsernameInput.value,
      password: accountPasswordInput.value,
    });
    if (result && result.ok === false) {
      accountStatus.textContent = result.error || "Login failed.";
      updatePlayAvailability();
      return;
    }
    accountPasswordInput.value = "";
    saveRememberedAccount();
    renderAccountSession(result?.session || result);
  } catch (error) {
    accountStatus.textContent = friendlyError(error);
    updatePlayAvailability();
  } finally {
    accountLoginButton.disabled = false;
    accountLoginButton.textContent = loginButtonText;
  }
}

async function logoutAccount() {
  if (!accountUsernameInput || !accountPasswordInput) return;
  setError("");
  accountUsernameInput.value = "";
  accountPasswordInput.value = "";
  renderAccountSession(await window.launcher.logoutAccount());
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

function formatJobName(jobName) {
  const cleaned = String(jobName || "Beginner").trim();
  if (!cleaned) return "Beginner";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function createRankCard(character, place) {
  const card = document.createElement("article");
  card.className = `rank-card rank-${place}`;

  const badge = document.createElement("div");
  badge.className = "rank-badge";
  badge.textContent = String(place);

  const avatarWrap = document.createElement("div");
  avatarWrap.className = "rank-avatar-wrap";

  const avatar = document.createElement("img");
  avatar.className = "rank-avatar";
  avatar.alt = character.name;
  avatar.draggable = false;
  avatar.src = character.avatarUrl;
  if (character.avatarWidth) {
    avatar.style.setProperty("--avatar-width", `${character.avatarWidth}px`);
  }
  avatarWrap.appendChild(avatar);

  const label = document.createElement("div");
  label.className = "rank-nameplate";
  const nameLine = document.createElement("strong");
  nameLine.textContent = character.name;
  const detailLine = document.createElement("span");
  detailLine.textContent = `${formatJobName(character.jobName)} Lv. ${character.level}`;
  label.append(nameLine, detailLine);

  card.append(badge, avatarWrap, label);
  return card;
}

function renderRankingsPodium(characters) {
  rankingsPodium.replaceChildren();
  const topThree = Array.isArray(characters) ? characters.slice(0, 3) : [];
  if (!topThree.length) {
    scrollBody.hidden = false;
    scrollBody.textContent = "Rankings are unavailable right now.";
    rankingsPodium.hidden = true;
    return;
  }

  scrollBody.hidden = true;
  rankingsPodium.hidden = false;
  topThree.forEach((character, index) => {
    rankingsPodium.appendChild(createRankCard(character, index + 1));
  });
}

function clearRankingsPodium() {
  rankingsPodium.replaceChildren();
  rankingsPodium.hidden = true;
}

async function loadRankingsPodium() {
  if (rankingsCache) {
    renderRankingsPodium(rankingsCache);
    return;
  }
  if (rankingsLoading) return;

  rankingsLoading = true;
  scrollBody.hidden = false;
  rankingsPodium.hidden = true;
  scrollBody.textContent = "Loading the top champions...";
  try {
    const rankings = await window.launcher.getRankings();
    rankingsCache = Array.isArray(rankings) ? rankings.slice(0, 3) : [];
    if (activeScrollPanel === "rankings") renderRankingsPodium(rankingsCache);
  } catch {
    if (activeScrollPanel === "rankings") {
      scrollBody.hidden = false;
      clearRankingsPodium();
      scrollBody.textContent = "Rankings are unavailable right now.";
    }
  } finally {
    rankingsLoading = false;
  }
}

function closeScrollPanel(afterClose) {
  window.clearTimeout(scrollCloseTimer);
  window.clearTimeout(scrollFadeTimer);
  window.clearTimeout(scrollFloatTimer);
  window.clearTimeout(scrollTextTimer);
  clearRankingsPodium();
  scrollBody.hidden = false;
  scrollDialog.classList.remove("has-rankings");
  if (scrollDialog.hidden) {
    if (afterClose) afterClose();
    return;
  }

  scrollDialog.classList.remove("is-fading", "is-floating", "is-switching");
  scrollDialog.classList.add("is-closing");
  scrollCloseTimer = window.setTimeout(() => {
    scrollDialog.hidden = true;
    scrollDialog.classList.remove("is-closing", "is-fading", "is-floating", "is-switching", "has-rankings");
    activeScrollPanel = null;
    if (afterClose) afterClose();
  }, 260);
}

function setScrollContent(panelName) {
  const panel = SCROLL_PANELS[panelName] || SCROLL_PANELS.news;
  scrollTitle.textContent = panel.title;
  scrollBody.textContent = panel.body;
  activeScrollPanel = panelName;
  scrollDialog.classList.toggle("has-rankings", panelName === "rankings");
  scrollBody.hidden = false;
  if (panelName !== "rankings") clearRankingsPodium();
  else rankingsPodium.hidden = true;
  if (panelName === "rankings") loadRankingsPodium();
}

function switchScrollPanel(panelName) {
  if (panelName === activeScrollPanel) return;
  window.clearTimeout(scrollTextTimer);
  if (panelName !== "rankings") {
    scrollDialog.classList.remove("has-rankings");
    clearRankingsPodium();
    scrollBody.hidden = false;
  }
  scrollDialog.classList.add("is-switching");
  scrollTextTimer = window.setTimeout(() => {
    setScrollContent(panelName);
    scrollDialog.classList.remove("is-switching");
  }, 120);
}

function openScrollPanel(panelName) {
  if (!scrollDialog.hidden && !scrollDialog.classList.contains("is-closing")) {
    switchScrollPanel(panelName);
    return;
  }

  setScrollContent(panelName);
  scrollDialog.hidden = false;
  scrollDialog.classList.remove("is-closing", "is-fading", "is-switching", "is-floating");

  window.clearTimeout(scrollCloseTimer);
  window.clearTimeout(scrollFadeTimer);
  window.clearTimeout(scrollFloatTimer);
  window.clearTimeout(scrollTextTimer);
  scrollFloatTimer = window.setTimeout(() => {
    if (!scrollDialog.hidden && !scrollDialog.classList.contains("is-closing")) {
      scrollDialog.classList.add("is-floating");
    }
  }, 380);
}

function setSettingsFormEnabled(enabled) {
  for (const input of [
    displayModeInput,
    resolutionInput,
    borderlessInput,
    settingsSaveButton,
  ]) {
    input.disabled = !enabled;
  }
}

function populateSettingsForm(settings) {
  displayModeInput.value = settings.displayMode || "fullscreen";
  resolutionInput.value = `${settings.width || 1920}x${settings.height || 1080}`;
  borderlessInput.checked = Boolean(settings.borderless);
}

async function saveSettings() {
  settingsSaveButton.disabled = true;
  const [width, height] = resolutionInput.value
    .split("x")
    .map((value) => Number(value));
  try {
    const settings = await window.launcher.saveSettings({
      displayMode: displayModeInput.value,
      width,
      height,
      borderless: borderlessInput.checked,
    });
    settingsPath.textContent = `Saved to ${settings.configPath}`;
    closeSettings();
  } catch (error) {
    settingsPath.textContent = friendlyError(error);
  } finally {
    settingsSaveButton.disabled = false;
  }
}

async function openInstallDirectory() {
  settingsOpenInstallButton.disabled = true;
  try {
    const result = await window.launcher.openInstallDirectory();
    settingsPath.textContent = `Opened ${result.path}`;
  } catch (error) {
    settingsPath.textContent = friendlyError(error);
  } finally {
    settingsOpenInstallButton.disabled = false;
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
if (accountLoginForm) accountLoginForm.addEventListener("submit", loginAccount);
if (accountLogoutButton) accountLogoutButton.addEventListener("click", logoutAccount);
if (accountRememberInput) accountRememberInput.addEventListener("change", saveRememberedAccount);
if (accountForgotButton) accountForgotButton.addEventListener("click", () => window.launcher.openPasswordRecovery());
if (accountRegisterButton) accountRegisterButton.addEventListener("click", () => window.launcher.openRegister());
if (accountList) accountList.addEventListener("scroll", updateAccountScrollState);
if (accountList) accountList.addEventListener("wheel", handleAccountListWheel, { passive: true });
minimizeButton.addEventListener("click", () => window.launcher.minimize());
closeButton.addEventListener("click", () => window.launcher.close());
settingsButton.addEventListener("click", openSettings);
settingsCloseButton.addEventListener("click", closeSettings);
settingsOpenInstallButton.addEventListener("click", openInstallDirectory);
settingsCancelButton.addEventListener("click", closeSettings);
settingsSaveButton.addEventListener("click", saveSettings);
settingsDialog.addEventListener("click", (event) => {
  if (event.target === settingsDialog) closeSettings();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !settingsDialog.hidden) closeSettings();
  if (event.key === "Escape" && !scrollDialog.hidden) closeScrollPanel();
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
  window.launcher.startWindowDrag({
    screenX: event.screenX,
    screenY: event.screenY,
  });
});
titlebar.addEventListener("pointermove", (event) => {
  if (!draggingWindow) return;
  window.launcher.moveWindowDrag({
    screenX: event.screenX,
    screenY: event.screenY,
  });
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
    const action = item.dataset.action;
    if (action) return;

    navItems.forEach((navItem) => navItem.classList.remove("active"));
    item.classList.add("active");

    if (item.dataset.panel === "home") {
      if (ACCOUNT_LOGIN_ENABLED && accountPanel) {
        accountPanel.hidden = false;
        accountPanel.classList.remove("is-hidden");
      }
      closeScrollPanel();
      return;
    }

    if (item.dataset.scrollPanel) {
      if (accountPanel) {
        accountPanel.hidden = true;
        accountPanel.classList.add("is-hidden");
      }
      openScrollPanel(item.dataset.scrollPanel);
    }
  });
}

if (donateButton) {
  donateButton.addEventListener("click", () => {
    donateButton.blur();
    window.launcher.openDonate();
  });
}

if (discordButton) {
  discordButton.addEventListener("click", () => {
    discordButton.blur();
    window.launcher.openDiscord();
  });
}

window.launcher.getState().then((state) => {
  launcherVersion = state.launcherVersion || "";
  if (gameName) gameName.textContent = state.gameName;
  clientDir.textContent = state.clientDir;
  patchUrl.textContent = state.patchBaseUrl;
  versionLabel.textContent = launcherVersion
    ? `Launcher v${launcherVersion}`
    : "Checking client version...";
  if (launcherVersionLabel) {
    launcherVersionLabel.textContent = launcherVersion ? `v${launcherVersion}` : "";
  }
  setServer(state.server);
  if (ACCOUNT_LOGIN_ENABLED && accountPanel) {
    accountPanel.hidden = false;
    renderAccountSession(state.accountSession);
  }
  loadNews(state.patchBaseUrl);
  const pollMs = Math.max(1000, Number(state.statusPollMs) || 3000);
  if (serverRefreshTimer) window.clearInterval(serverRefreshTimer);
  serverRefreshTimer = window.setInterval(refreshServer, pollMs);
});

refreshServer();
if (ACCOUNT_LOGIN_ENABLED) loadRememberedAccount();
updatePlayAvailability();
