# BrulunaMS Launcher

14 November candidate: website-account login and linked game-account selection are restored in source. Play requests a one-time ticket through the HTTPS website `/api/game/launcher-ticket` route and passes it in the launched process environment. The paired native mod reads and clears that handoff; it does not use a shared INI ticket. This requires the new native candidate and restarted website/Login service. Offline tests pass; no desktop launch or live auto-login acceptance has been performed. Run `node --test scripts/auto-login.test.cjs` for handoff isolation and UI wiring checks.

Electron launcher and static patch tooling for the BrulunaMS v62 client.

Workspace reorganization: the actual `publish-client.bat`, `publish-launcher-update.bat`, and `start-public-patch-server.bat` entry files now live in `C:\Maplestory\V62\START HERE`. npm commands still run from this source directory. Launcher updates are served directly from `C:\Maplestory\V62\Published Version - Launcher`; they are not copied into the testing-client feed.

Defaults:

- Game executable: `BrulunaMS.exe`
- Launch arguments: none
- Patch URL: `http://lobbyx3.serveminecraft.net:1717`, with automatic local fallback to `http://127.0.0.1:1717` when the launcher is running on the server PC.
- Local packaged client folder: `<launcher folder>\Client`
- Packaged launcher runtime client folder: `%LOCALAPPDATA%\BrulunaMS Launcher\Client`
- Authoritative publish source: `C:\Maplestory\V62\Development\Publishing folder`

## First Setup

```powershell
cd <launcher source folder>
cmd /c npm install
```

PowerShell may block `npm.ps1`; using `cmd /c npm ...` avoids that local execution policy issue.

## Local Test

Publish the current client:

```powershell
cmd /c npm run publish:client
```

Start the local patch server:

```powershell
cmd /c npm run serve:patch
```

In another terminal, run the launcher:

```powershell
cmd /c npm start
```

## Configure Public URL

Edit these values before a real release:

- `src/config.js`: `PUBLIC_PATCH_BASE_URL`
- `src/config.js`: `LOCAL_PATCH_BASE_URL` for the server PC/local test fallback
- `package.json`: `build.publish[0].url`
- `start-public-patch-server.bat`: visible public URL text, if desired

## Local Server PC Login

The native game launcher reads `[MapleClient] ServerHost` from the local `config.ini`.
Use `ServerHost=127.0.0.1` only on the server owner's local client to avoid public-IP hairpin/NAT loopback issues.
Leave release/client-seed configs unset or set to `lobbyx3.serveminecraft.net` so remote players keep using the public address.

The static server can be exposed with:

```powershell
node scripts\server.js --public "C:\Maplestory\V62\Development\Publishing folder\.patch\public" --host 0.0.0.0 --port 1717
```

## Release Helpers

- `publish-client.bat` creates `latest.json`, a manifest, news placeholder, and hashed blobs.
- `start-public-patch-server.bat` serves the generated patch folder.
- `publish-launcher-update.bat` builds the NSIS installer and copies updater files into `Client\.patch\public\launcher`.
- The launcher silently installs launcher updates as soon as it detects them, then relaunches itself.
- Older setup files check `launcher/latest.yml` before installing and hand off to the newest published setup when one exists.
- Packaged builds store the mutable client under `%LOCALAPPDATA%\BrulunaMS Launcher\Client`, not inside the launcher install folder. This prevents launcher self-updates from replacing the client with the bundled seed and forcing a full client repair.
- If an older launcher already had a client in `<launcher install folder>\Client`, the new launcher migrates that folder to `%LOCALAPPDATA%\BrulunaMS Launcher\Client` once and preserves `.launcher\installed.json` so normal manifest-version checks still work.
- Normal Play/start update checks trust `.launcher\installed.json` when its `manifestSha256` matches the server `latest.json`. This prevents a launcher self-update from re-verifying or re-downloading the full 1GB client when the client manifest is already current. Use Repair for an explicit full file verification.
- Launcher `1.0.67` narrows the "game is running" patch guard to the real game executables and reports the exact process names/PIDs it detects. Multi-client play is still allowed; the guard only blocks patch/repair while shared client files would be replaced.

## Stuck Old Launcher Process Guard

For users still on an older launcher that says the game is running after closing it, have them run this in PowerShell. It closes only game-client executables, waits for Windows to remove them from the process table, and does not target `BrulunaMS Launcher.exe`.

```powershell
$names = @('BrulunaMS.exe', 'BrulunaMS_Windowed.exe', 'BrulunaMS_Fullscreen.exe')
$deadline = (Get-Date).AddSeconds(20)
do {
  $procs = Get-CimInstance Win32_Process | Where-Object { $names -contains $_.Name }
  foreach ($proc in $procs) {
    taskkill /PID $proc.ProcessId /F /T | Out-Null
  }
  if (-not $procs) { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

Get-CimInstance Win32_Process |
  Where-Object { $names -contains $_.Name } |
  Select-Object ProcessId, ParentProcessId, Name, ExecutablePath
```

If the final command prints no rows, reopen the launcher and patch. If it prints rows, those exact PIDs are still alive and should be sent with the support report.

## Launcher UI Notes

- The bottom-left version label shows only the short app version, such as `v1.0.57`.
- The Settings panel includes `Open Install Directory`, which opens the installed launcher folder in packaged builds and the source folder during local development.
- The Donate button opens `https://paypal.me/brulunams`.
- The Discord button opens the configured Discord invite.
- Donate and Discord are compact one-row sidebar buttons rendered from trimmed sidebar derivatives of the dedicated high-resolution button assets: `assets\btn-donate-sidebar-normal.png`, `assets\btn-donate-sidebar-highlighted.png`, `assets\btn-discord-sidebar-normal.png`, and `assets\btn-discord-sidebar-highlighted.png`. Their combined row width matches the main nav buttons exactly: `105 + 105 = 210` on the normal layout and `97 + 97 = 194` on the smaller responsive layout.
- Donate and Discord use hover highlight only and blur after click so they do not remain visually selected.
- The Online/Offline status card is placed low enough for the side mushroom art to overlap it slightly.
- Launcher `1.0.68` refreshes the Online/Offline status every 3 seconds and prevents overlapping status checks if a network probe is still running.
- Launcher `1.0.70` treats only the configured required live services as authoritative for the Online/Offline pill. `src\config.js` sets `LIVE_STATUS_REQUIRED_SERVICES` to `["Login", "Game"]`; `src\main.js` still probes Patch, Center, Login, Game, and Shop for diagnostics, but `pingPatchServer()` returns `online=true` when Login and Game are reachable even if optional probes fail. This prevents the launcher from showing Offline while players are already connected and playing.
- Launcher `1.0.71` replaces the hardcoded numeric patch/ticket host `46.117.116.14` with `lobbyx3.serveminecraft.net`. On 2026-06-24 the machine's public IP had changed to `46.116.181.138`, while old launchers still requested `http://46.117.116.14:1717/launcher/latest.yml`; those requests timed out, so players saw Offline and could not receive launcher updates. The DDNS hostname resolved to the current IP and tested reachable on ports `1717`, `8484`, and `8585`. Players already stuck on the dead numeric IP need to install the `1.0.71` setup once, because their old launcher cannot fetch an update from an IP that no longer belongs to this server.
- The unpublished FHD launcher test build uses the new native injector config. The authoritative config template is `C:\Maplestory\V62\Development\Server + testing client\Client source\dllprojects\config.ini` and contains only `[MapleClient]`, `ClientExe=BrulunaMS_Windowed.exe`, `Width`, `Height`, `Borderless`, and `Windowed`. The launcher Settings window now only exposes display mode, resolution, and borderless mode; supported resolutions are currently `800x600` and `1920x1080`. Saving Settings rewrites `config.ini` in that minimal format.
- The unpublished FHD launcher test build is built locally with `npm run dist:win:installer`, not published. It packages the active test client seed from `C:\Maplestory\V62\Development\Server + testing client\Testing client`, including `BrulunaMS.exe`, `BrulunaMS_Windowed.exe`, `BrulunaMS_Mod.dll`, `BrulunaMS.dll`, and the new config template.
- Launcher `1.0.70` temporarily disables the Home account/login panel and launcher auto-login flow. `src\index.html` no longer declares `#accountPanel`, `src\renderer.js` uses `ACCOUNT_LOGIN_ENABLED=false`, and `src\main.js` uses `LAUNCHER_AUTO_LOGIN_ENABLED=false`, so Play launches after update checks without requiring a selected account or writing a one-time `[LauncherAutoLogin]` ticket. The dormant renderer account helpers are null-guarded so the account panel can be restored later without reworking the rest of the launcher.
- Launcher `1.0.69` is the published FHD/native-injector update. Publish flow: run `npm run publish:client` to sync `C:\Maplestory\V62\Development\Server + testing client\Testing client` into `C:\Maplestory\V62\Development\Publishing folder`, generate the client manifest/news feed, and mirror public patch blobs; then run `publish-launcher-update.bat` to build the compressed installer and copy `latest.yml`, setup exe, and blockmap into the public launcher feed.
- News copy for this update is `FHD Client is now live!`. The renderer fallback shows this in the News panel, and `scripts\publisher.js` writes the same text to `news\live.json` when the client patch feed is generated.
- News, Events, and Rankings share the liquid-glass panel. Switching away from Rankings clears the podium DOM so News and Events never show ranking sprites.
- Returning to Home closes the panel with a single close animation, then hides it after the animation completes.
- Rankings loads the top three characters from `RANKINGS_API_URL` and renders their model, name, job, and level in the podium.
- Home now shows a floating liquid-glass account panel in the same top-right stage position as the News/Events/Rankings panel. The panel is declared in `src/index.html` as `#accountPanel`, styled in `src/styles.css` with the same shine/ripple glass primitives as `#scrollDialog`, centered with `display: grid`, `place-items: center`, and `.account-content { align-content: center; justify-items: center; }`, and hidden with `.is-hidden` when a non-Home nav item is selected. The logged-out idle status line is intentionally empty so the form stays clean.
- Home, News, Events, and Rankings no longer depend on the old `assets\nav\*-normal.png` and `*-selected.png` images for their visible state. Their liquid-glass button look is recreated in CSS under the `.nav-home`, `.nav-news`, `.nav-events`, and `.nav-rankings` selectors, with a soft hover sheen from `nav-glass-sheen` and a restrained selected sweep from `nav-selected-shine`.
- Donate and Discord are aligned to the same vertical start/end lines as the full nav buttons by using a two-column nav grid of `101px + 8px + 101px = 210px` on the normal layout and `93px + 8px + 93px = 194px` on the compact layout. The individual Donate/Discord buttons have no side margins.
- Launcher account login is source-only and not published. `src/config.js` defines `LOGIN_API_KIND: "custom"`, `LOGIN_API_URL: "https://api.lobbyx3.com/api/auth/login"`, `ACCOUNT_LIST_API_URL`, `PASSWORD_RECOVERY_URL`, and `REGISTER_URL`; `src/main.js` posts username/password to the login endpoint through `fetchAuthJson`, captures the login response cookie in memory, and sends that cookie plus any bearer token to `/game/accounts` so account loading matches the website's `withCredentials` flow. It normalizes common response shapes (`access_token`, `token`, `data`, `data.accounts`, `gameAccounts`, `characters`, etc.), stores only the temporary in-memory launcher session, and exposes safe session state through IPC. Keep this auth helper named differently from the patcher's later `fetchJson(url)` helper, because that helper is GET-only for patch manifests.
- `src/preload.js` exposes `getAccountSession`, `loginAccount`, `selectAccount`, `logoutAccount`, `openPasswordRecovery`, and `openRegister`. `src/renderer.js` renders returned game accounts as selectable `.account-choice` buttons, saves only the remembered username and remember flag in renderer `localStorage` when Remember Me is enabled, and opens the configured forgot-password/register pages through main-process IPC. `launcher:play` refuses to launch until `selectedAccountId` exists, and the renderer keeps the Play button visually locked until an account has been selected.
- On Play, `src/main.js` requests a one-time launcher login ticket from `LAUNCHER_LOGIN_TICKET_URL` using the in-memory website session cookie and selected game account name, then writes `[LauncherAutoLogin] Enabled=1`, `Account`, `Ticket`, and `CreatedAt` into client `config.ini`. The native injected DLL consumes that handoff and turns `Enabled` back off after reading it. Do not replace this with real password handoff.
- To recreate the account gate from scratch: add the custom auth endpoint, account-list API URL, recovery URL, and register URL to `src/config.js`; add the account session helpers, login-cookie capture, account-list cookie forwarding, and IPC handlers in `src/main.js`; expose those handlers in `src/preload.js`; add `#accountPanel` to the Home hero area in `src/index.html`; render/login/select/logout/remember/link behavior in `src/renderer.js`; then add the `.account-panel`, `.account-choice`, `.account-login-button`, `.account-options`, `.remember-switch`, `.account-links`, and locked `#playButton.is-locked` styles in `src/styles.css`. The Remember Me switch has no on/off text inside the pill, the Login button intentionally uses the same lighter blue glass family as the Logout button, the selected account status reads `Selected Account: <name>`, and the account list uses a taller backgroundless liquid-glass scrollbar with no arrow buttons plus top/bottom edge pulse classes from `updateAccountScrollState()`.

Images can be added later under `assets\`. The UI already references optional `assets\background.png` and `assets\logo.png`.

## Workspace storage cleanup (2026-09-09)

The publish-client.bat workflow copies clean files from client/MapleStory to
BrulunaMS-Launcher/Client, publishes the versioned manifest and latest.json there,
and restarts the patch server against BrulunaMS-Launcher/Client/.patch/public.
The publisher no longer mirrors that feed into client/MapleStory/.patch/public.
Removed LEGACY_PUBLIC_MIRRORS, mirrorPublicFolder, its call, and the now-unused
copyDirectory helper; the authoritative publishing feed and version history remain intact.
The redundant development .patch folder can therefore be removed without being
recreated by publishing. Do not remove the publishing feed.

The server's clientcrash.status and clientpackettrace.status debug properties
were set to false to prevent multi-gigabyte diagnostic logs during ordinary play.
Running server processes load these settings on restart. Enable the relevant flag
in server/argonms-server-master/server.properties only for focused diagnosis,
then disable it and restart again. The two historical debug log files were selected
for truncation; no Java build is required for these property changes.
Release-Version/Ai-place-here was initially excluded: its current WZ files differ
from the development client, so it must not be treated as an exact duplicate.
The later explicitly requested WZ backup cleanup below preserves those current files.

A second cleanup pruned older publishing manifests and blobs, retaining current
release 2026.06.13.629 and previous release 2026.06.13.091. The retained releases
were chosen from latest.json and manifest generatedAt timestamps (not filename
sorting). All 72 distinct retained blobs passed SHA-256 verification before cleanup.
Only files under .patch/public/files/sha256 and .patch/public/manifests were
selected; latest.json, launcher updates, news, and playable client files were kept.
The reviewed removal list contained 10,140 files totaling 12,706,934,108 bytes.
Older releases are no longer available for rollback from this publishing feed.
For future manual pruning, retain latest.json's manifest and at least one previous
manifest, collect their files[].sha256 values, verify every retained blob, then
remove only older manifests and blobs outside that union. Check latest.json has
not changed before deletion; do not prune while publishing or updating clients.
New publishes can accumulate history again; automatic pruning was not added.

### Release WZ backup cleanup (2026-09-10)

Following explicit user authorization to clean this folder, removed 56 older
WZ backups totaling 21,685,978,460 bytes (20.20 GiB). Retained the newest
before-change backup per WZ type using the final filename date/time where
available, with modification time as fallback. SHA-256 checks before and after
deletion confirmed all 17 current root WZ files and five retained backups were
unchanged. This preserves individual recent backups, not an in-game-validated
whole-client rollback snapshot. Executables, DLLs, the old .patch feed, and other
files were outside this deletion list.

Retained backups:

- `Character.wz.backup-before-squishy-real-icon-20260528-194047`
- `Map.wz.backup-before-682000304-xmlrestore-20260530-125510`
- `Npc.wz.backup-before-happy-family-bigger-20260526-195042`
- `String.wz.backup-before-squishy-shoes-20260528-190639`
- `backups\UI.wz.before-maplelegends-data-loader-20260526-201244`

Removed backup filenames (these historical copies are no longer available):

- `Character.wz.backup-before-squishy-icon-20260528-192913`
- `Character.wz.backup-before-squishy-shoes-20260528-190639`
- `Map.wz.backup-before-20260526-clean-bg-blue-city-dots-20260526-153000`
- `Map.wz.backup-before-20260526-full-v62-singapore-maplist-20260526-155500`
- `Map.wz.backup-before-20260526-mainland-ghostship-split-20260526-155703`
- `Map.wz.backup-before-20260526-mapleroyals-ghostship-baseimg-20260526-173506`
- `Map.wz.backup-before-20260526-mapped-mini-singapore-20260526-151000`
- `Map.wz.backup-before-20260526-ml-worldmap145-singapore`
- `Map.wz.backup-before-20260526-singapore-child-over-worldmap140`
- `Map.wz.backup-before-20260526-singapore-over-worldmap140-diagnostic`
- `Map.wz.backup-before-20260526-singleton-index0-type1-20260526-144758`
- `Map.wz.backup-before-20260526-v62-native-worldmap140-singapore-png`
- `Map.wz.backup-before-682000404-xmlrestore-20260530-124818`
- `Map.wz.backup-before-delete-worldmap220-20260525-191650`
- `Map.wz.backup-before-diagnostic-worldmap10-boatquay-20260526-113419`
- `Map.wz.backup-before-direct-worldmap220-route-20260525-194144`
- `Map.wz.backup-before-full-worldmap-20260525-175030`
- `Map.wz.backup-before-mapleroyals-singapore-20260525-204233`
- `Map.wz.backup-before-maplink8-singapore-20260526-111648`
- `Map.wz.backup-before-minimal-boatquay-worldmap-route-20260525-193049`
- `Map.wz.backup-before-remove-root-boatquay-20260526-112135`
- `Map.wz.backup-before-remove-worldmap140-disclaimer-20260525-195021`
- `Map.wz.backup-before-remove-worldmap140-maplink-20260525-200521`
- `Map.wz.backup-before-restore-noninstant-worldmap-20260525-190651`
- `Map.wz.backup-before-restore-pre-worldmap-import-20260525-192526`
- `Map.wz.backup-before-restore-stable-worldmap140-20260525-201225`
- `Map.wz.backup-before-restore-worldmap140-base-20260525-190134`
- `Map.wz.backup-before-restore-worldmap220-and-parent-mapids-20260525-190930`
- `Map.wz.backup-before-safe-worldmap140-baseimg-20260525-200951`
- `Map.wz.backup-before-singapore-both-worldmap-copies-20260525-185404`
- `Map.wz.backup-before-singapore-parent-node-fields-20260525-185704`
- `Map.wz.backup-before-singapore-parent-worldmap-20260525-185334`
- `Map.wz.backup-before-singapore-remove-parent-path-canvases-20260525-190052`
- `Map.wz.backup-before-singapore-worldmap-all-540-541-20260525-184445`
- `Map.wz.backup-before-singapore-worldmap-drawn-bg-20260525-184542`
- `Map.wz.backup-before-singapore-worldmap-fieldlimit-20260525-175629`
- `Map.wz.backup-before-singapore-worldmap-selected-20260525-181552`
- `Map.wz.backup-before-singapore-worldmap140-parent-20260525-194706`
- `Map.wz.backup-before-singapore-worldmap220-v62safe-20260525-184057`
- `Map.wz.backup-before-worldmap-canvas-fill-20260525-183635`
- `Map.wz.backup-before-worldmap-canvas-import-20260525-181209`
- `Map.wz.backup-before-worldmap-canvas-import-20260525-181220`
- `Map.wz.backup-before-worldmap-dir-fix-20260525-183205`
- `Map.wz.backup-before-worldmap13-v62-singapore-20260526-113737`
- `Map.wz.backup-before-worldmap140-boatquay-type0-20260525-200729`
- `Map.wz.backup-before-worldmap140-link-route-20260525-193813`
- `Map.wz.backup-before-worldmap140-maplist1-type1-20260525-195934`
- `Map.wz.backup-before-worldmap220-from-mapleroyals010-20260526-112421`
- `Map.wz.backup-before-worldmap220-parent-fix-20260525-194454`
- `Map.wz.backup-crashing-full-map5-import-20260525-180056`
- `Npc.wz.backup-before-daniel-family-ron-20260526-192530`
- `Npc.wz.backup-before-daniel-family-ron-bigger-20260526-193616`
- `Npc.wz.backup-before-daniel-family-ron-delay100-20260526-194254`
- `String.wz.backup-before-daniel-family-ron-20260526-192530`
- `backups\UI.wz.before-uiwzswap-1024x768-20260526-175043`
- `backups\UI.wz.moved-for-maplelegends-data-loader-20260526-201244`
