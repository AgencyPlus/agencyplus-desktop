# AgencyPlus Desktop — Electron wrapper

The desktop app is a thin Electron shell around the live Netlify web app.
The UI is always up to date automatically. This repo only releases when the
native wrapper itself needs an update (new system features, security patches).

## First-time setup

```bash
cd electron
npm install
```

### Set your live URL

Edit `src/main.js` line 16 — change `APP_URL` to your actual Netlify domain:

```js
const APP_URL = 'https://your-actual-domain.netlify.app';
```

### Set your GitHub repo for auto-updates

Edit `package.json` → `build.publish`:

```json
"publish": {
  "provider": "github",
  "owner":    "your-github-username",
  "repo":     "agencyplus-desktop"
}
```

### Set a `GH_TOKEN` environment variable

Auto-updates require a GitHub personal access token with `repo` scope:

```bash
export GH_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
```

## Development

```bash
npm start                          # opens the app pointing at APP_URL
AGENCYPLUS_DEV_URL=http://localhost:3000 npm start   # point at local frontend
```

## Building

```bash
npm run dist:win    # → dist/AgencyPlus Setup 1.0.0.exe
npm run dist:mac    # → dist/AgencyPlus-1.0.0.dmg  (run on macOS)
npm run dist:linux  # → dist/AgencyPlus-1.0.0.AppImage
npm run dist        # builds for current platform
```

Upload the output files from `dist/` to a GitHub Release. `electron-updater`
checks for new releases automatically every 4 hours while the app is running.

## Assets

Place your icon files in `electron/assets/`:

| File           | Used for                         | Recommended size |
|----------------|----------------------------------|------------------|
| `icon.icns`    | macOS                            | 512×512 pt       |
| `icon.ico`     | Windows                          | 256×256 px       |
| `icon.png`     | Linux + tray + loading state     | 512×512 px       |

You can generate `.icns` and `.ico` from a single PNG using
[`electron-icon-maker`](https://www.npmjs.com/package/electron-icon-maker):

```bash
npx electron-icon-maker --input=assets/icon.png --output=assets/
```

## How updates work

1. You push a new version: bump `version` in `package.json`, push a GitHub
   Release tag `v1.0.1`, attach the platform installers.
2. Each running desktop app checks GitHub every 4 hours.
3. When a new release is found it downloads silently in the background.
4. A dialog asks the user to restart now or later.

UI updates (new pages, bug fixes on the frontend) happen instantly without
any of this — they come from Netlify like a normal page load.
