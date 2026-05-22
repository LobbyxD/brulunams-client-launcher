# BrulunaMS Launcher

Electron launcher and static patch tooling for the BrulunaMS v62 client.

Defaults:

- Game executable: `BrulunaMS.exe`
- Launch arguments: none
- Patch URL: `http://46.117.116.14:1717`, with automatic local fallback to `http://127.0.0.1:1717` when the launcher is running on the server PC.
- Local packaged client folder: `<launcher folder>\Client`
- Authoritative publish source: `C:\Maplestory\V62\client\Release-Version\Ai-place-here`

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
node scripts\server.js --public "C:\Maplestory\V62\client\Release-Version\Ai-place-here\.patch\public" --host 0.0.0.0 --port 1717
```

## Release Helpers

- `publish-client.bat` creates `latest.json`, a manifest, news placeholder, and hashed blobs.
- `start-public-patch-server.bat` serves the generated patch folder.
- `publish-launcher-update.bat` builds the NSIS installer and copies updater files into `Client\.patch\public\launcher`.

Images can be added later under `assets\`. The UI already references optional `assets\background.png` and `assets\logo.png`.
