const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const SOURCE_CLIENT_DIR = "C:\\Maplestory\\V62\\client\\MapleStory";
const RELEASE_CLIENT_DIR = "C:\\Maplestory\\V62\\client\\Release-Version\\Ai-place-here";

const MUST_HAVE_FILES = [
  "Base.wz",
  "BrulunaMS.dll",
  "BrulunaMS.exe",
  "BrulunaMS_Fullscreen.exe",
  "BrulunaMS_Windowed.exe",
  "Canvas.dll",
  "Character.wz",
  "config.ini",
  "Effect.wz",
  "Etc.wz",
  "GameGuard.des",
  "Gr2D_DX8.dll",
  "ijl15.dll",
  "Item.wz",
  "l3codeca.acm",
  "List.wz",
  "Map.wz",
  "MapleStoryUS.ini",
  "Mob.wz",
  "mob_levels.tsv",
  "Morph.wz",
  "NameSpace.dll",
  "Npc.wz",
  "npkcrypt.dll",
  "npkcrypt.sys",
  "npkcrypt.vxd",
  "npkcusb.sys",
  "npkpdb.dll",
  "PCOM.dll",
  "Quest.wz",
  "Reactor.wz",
  "ResMan.dll",
  "Shape2D.dll",
  "Skill.wz",
  "Sound.wz",
  "Sound_DX8.dll",
  "String.wz",
  "TamingMob.wz",
  "UI.wz",
  "WzFlashRenderer.dll",
  "WzMss.dll",
  "ZLZ.dll"
];

const SYNC_FROM_SOURCE = MUST_HAVE_FILES;

const NOT_REQUIRED_PATTERNS = [
  "*.cpp",
  "*.log",
  "*.tmp",
  "*.bak",
  "*.backup-*",
  "*.before-*",
  "*.original-before-*",
  "*.patched-*",
  "*_debug.txt",
  "*_trace.txt",
  "backup",
  "backups",
  "backup-*",
  "_backup_*",
  "apply_quest_window_patch.ps1",
  "client_crash_debug.txt",
  "config.properties",
  "debug.txt",
  "donotcopy.exe",
  "GMSv62.exe",
  "GMSv62_Windowed.exe",
  "GMSv62_Windowed_2.exe",
  "GMSv62_Windowed_cashdrop.exe",
  "launcher_debug.txt",
  "launcher_selected_client.txt",
  "MapleClientLauncher.exe",
  "MapleClientMod.dll",
  "MapleStory.exe",
  "Patcher.exe",
  "Setup.exe"
];

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*/g, ".*");
  return new RegExp(`^${source}$`, "i");
}

const notRequiredRules = NOT_REQUIRED_PATTERNS.map(globToRegExp);

async function pathExists(filePath) {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function ensureInsideRelease(filePath) {
  const relative = path.relative(RELEASE_CLIENT_DIR, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to touch path outside release folder: ${filePath}`);
  }
}

async function copyRequiredFiles() {
  await fsp.mkdir(RELEASE_CLIENT_DIR, { recursive: true });

  for (const file of SYNC_FROM_SOURCE) {
    const source = path.join(SOURCE_CLIENT_DIR, file);
    const destination = path.join(RELEASE_CLIENT_DIR, file);

    if (!(await pathExists(source))) {
      throw new Error(`Missing required source file: ${source}`);
    }

    ensureInsideRelease(destination);
    await fsp.copyFile(source, destination);
    console.log(`Copied required file: ${file}`);
  }
}

async function cleanNotRequiredFiles() {
  const entries = await fsp.readdir(RELEASE_CLIENT_DIR, { withFileTypes: true });
  const removed = [];

  for (const entry of entries) {
    if (entry.name === ".patch") continue;
    if (!notRequiredRules.some((rule) => rule.test(entry.name))) continue;

    const target = path.join(RELEASE_CLIENT_DIR, entry.name);
    ensureInsideRelease(target);
    await fsp.rm(target, { recursive: true, force: true });
    removed.push(entry.name);
  }

  if (removed.length) {
    console.log(`Removed not-required release files: ${removed.join(", ")}`);
  } else {
    console.log("No not-required release files found.");
  }
}

async function forcePublicReleaseConfig() {
  const configPath = path.join(RELEASE_CLIENT_DIR, "config.ini");
  let text = await fsp.readFile(configPath, "utf8");
  if (/^\s*ServerHost\s*=/im.test(text)) {
    text = text.replace(/^\s*ServerHost\s*=.*$/im, "ServerHost=lobbyx3.serveminecraft.net");
  } else {
    if (!/\r?\n$/.test(text)) text += "\r\n";
    text += "ServerHost=lobbyx3.serveminecraft.net\r\n";
  }
  await fsp.writeFile(configPath, text, "ascii");
  console.log("Forced release config ServerHost=lobbyx3.serveminecraft.net");
}

async function validateMustHaveFiles() {
  const missing = [];
  for (const file of MUST_HAVE_FILES) {
    const absolute = path.join(RELEASE_CLIENT_DIR, file);
    if (!(await pathExists(absolute))) missing.push(file);
  }

  if (missing.length) {
    throw new Error(`Release folder is missing required files: ${missing.join(", ")}`);
  }

  console.log(`Validated ${MUST_HAVE_FILES.length} required release files.`);
}

async function main() {
  console.log(`Source client: ${SOURCE_CLIENT_DIR}`);
  console.log(`Release client: ${RELEASE_CLIENT_DIR}`);
  await copyRequiredFiles();
  await forcePublicReleaseConfig();
  await cleanNotRequiredFiles();
  await validateMustHaveFiles();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
