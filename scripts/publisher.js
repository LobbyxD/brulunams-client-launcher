const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const config = require("../src/config");

const DEFAULT_IGNORES = [
  ".patch/**",
  ".launcher/**",
  "Log/**",
  "logs/**",
  "*.log",
  "*_debug.txt",
  "*_trace.txt",
  "settings.ini",
  "resolution",
  "regInfo.dat",
  "screenshots/**",
  "_backup_*/**",
  "backup/**",
  "backups/**",
  "*.backup-*",
  "*.before-*",
  "*.original-before-*",
  "*.patched-*",
  "*.tmp",
  "*.bak",
  "*.cpp"
];

const LEGACY_DELETE_PATHS = [
  "apply_quest_window_patch.ps1",
  "BrulunaMS.exe.backup-restore-climb-actions-20260516-032853",
  "BrulunaMS.exe.backup-restore-full-movement-handler-20260516-034655",
  "BrulunaMS.exe.backup-restore-loop-guards-20260516-033921",
  "BrulunaMS.exe.before-gachapon-drop-exe-20260512-053318",
  "BrulunaMS.exe.before-multiclient-sync-20260512-191434",
  "client_crash_debug.txt",
  "config.properties",
  "debug.txt",
  "GMSv62.exe",
  "GMSv62_Windowed.exe",
  "GMSv62_Windowed_2.exe",
  "GMSv62_Windowed_cashdrop.exe",
  "launcher_debug.txt",
  "launcher_selected_client.txt",
  "MapleClientLauncher.cpp",
  "MapleClientLauncher.exe",
  "MapleClientMod.dll",
  "MapleClientMod.cpp",
  "MapleStory.exe",
  "Patcher.exe",
  "Setup.exe",
  "backup",
  "backups",
  "backup-before-quest-window-title-split-20260515-063956"
];

const LEGACY_PUBLIC_MIRRORS = [
  "C:\\Maplestory\\V62\\client\\MapleStory\\.patch\\public"
];

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function globToRegExp(pattern) {
  const normalized = pattern.trim().replace(/\\/g, "/");
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
  return new RegExp(`^${source}$`, "i");
}

function versionStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}.${pad(now.getMonth() + 1)}.${pad(now.getDate())}.${String(Date.now()).slice(-3)}`;
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

async function loadIgnoreRules(clientDir) {
  const patchIgnore = path.join(clientDir, "patchignore");
  const extra = [];
  try {
    const text = await fsp.readFile(patchIgnore, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) extra.push(trimmed);
    }
  } catch {
    // Optional file.
  }
  return [...DEFAULT_IGNORES, ...extra].map(globToRegExp);
}

function isIgnored(relativePath, rules) {
  const normalized = relativePath.replace(/\\/g, "/");
  return rules.some((rule) => rule.test(normalized));
}

async function walk(root, current, rules, results) {
  const entries = await fsp.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).replace(/\\/g, "/");
    if (isIgnored(relative, rules)) continue;
    if (entry.isDirectory()) {
      await walk(root, absolute, rules, results);
    } else if (entry.isFile()) {
      results.push({ absolute, relative });
    }
  }
}

async function copyBlob(source, publicDir, hash) {
  const blobDir = path.join(publicDir, "files", "sha256", hash.slice(0, 2));
  const blobPath = path.join(blobDir, hash);
  await fsp.mkdir(blobDir, { recursive: true });
  try {
    await fsp.copyFile(source, blobPath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

async function copyDirectory(sourceDir, targetDir) {
  const entries = await fsp.readdir(sourceDir, { withFileTypes: true });
  await fsp.mkdir(targetDir, { recursive: true });

  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(source, target);
    } else if (entry.isFile()) {
      await fsp.copyFile(source, target);
    }
  }
}

async function mirrorPublicFolder(publicDir) {
  for (const mirrorDir of LEGACY_PUBLIC_MIRRORS) {
    const resolvedMirror = path.resolve(mirrorDir);
    if (resolvedMirror.toLowerCase() === path.resolve(publicDir).toLowerCase()) continue;

    await fsp.rm(resolvedMirror, { recursive: true, force: true });
    await copyDirectory(publicDir, resolvedMirror);
    console.log(`Mirrored public patch feed: ${resolvedMirror}`);
  }
}

async function main() {
  const clientDir = path.resolve(argValue("--client", config.AUTHORITATIVE_CLIENT_DIR));
  const channel = argValue("--channel", "live");
  const version = argValue("--version", versionStamp());
  const publicDir = path.join(clientDir, ".patch", "public");
  const rules = await loadIgnoreRules(clientDir);
  const files = [];

  await walk(clientDir, clientDir, rules, files);
  await fsp.mkdir(path.join(publicDir, "manifests"), { recursive: true });
  await fsp.mkdir(path.join(publicDir, "news"), { recursive: true });

  const manifestFiles = [];
  for (const file of files) {
    const stat = await fsp.stat(file.absolute);
    const hash = await sha256File(file.absolute);
    await copyBlob(file.absolute, publicDir, hash);
    manifestFiles.push({
      path: file.relative,
      size: stat.size,
      sha256: hash,
      url: `/files/sha256/${hash.slice(0, 2)}/${hash}`,
      executable: file.relative.toLowerCase().endsWith(".exe")
    });
  }

  manifestFiles.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = {
    gameVersion: version,
    channel,
    generatedAt: new Date().toISOString(),
    baseUrl: "",
    files: manifestFiles,
    delete: LEGACY_DELETE_PATHS.filter((relativePath) => !manifestFiles.some((file) => file.path.toLowerCase() === relativePath.toLowerCase()))
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestSha256 = crypto.createHash("sha256").update(manifestText).digest("hex");
  const manifestName = `${version}.json`;
  await fsp.writeFile(path.join(publicDir, "manifests", manifestName), manifestText);

  const latest = {
    channel,
    gameVersion: version,
    manifestUrl: `/manifests/${manifestName}`,
    manifestSha256,
    minLauncherVersion: "1.0.0",
    launcherUpdateRequired: false,
    newsUrl: "/news/live.json"
  };
  await fsp.writeFile(path.join(publicDir, "latest.json"), `${JSON.stringify(latest, null, 2)}\n`);

  const newsPath = path.join(publicDir, "news", "live.json");
  if (!fs.existsSync(newsPath)) {
    await fsp.writeFile(newsPath, `${JSON.stringify({ items: [{ title: "Welcome to BrulunaMS", body: "Client is ready for adventure." }] }, null, 2)}\n`);
  }

  await mirrorPublicFolder(publicDir);

  console.log(`Published ${manifestFiles.length} files.`);
  console.log(`Version: ${version}`);
  console.log(`Public folder: ${publicDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
