# antics for Windows

antics in its own window, with its own icon, a desktop shortcut and a Start-menu entry. No browser
tabs, no address bar.

The app opens the live site, https://tendha2020-ai.github.io/account-shop/animals/, so every update to
antics shows up in the app as soon as it's on the site. You don't need to reinstall the app to get
updates. It uses the same worker as the site and your phone.

## Install

1. Download **antics-Setup.exe** from
   https://github.com/tendha2020-ai/account-shop/raw/downloads/antics-Setup.exe
   (or, in antics in your browser on this PC: **⚙ Settings → Get the antics app for Windows**). If your browser
   warns that the file "isn't commonly downloaded", choose **Keep**.
2. Open it. The app isn't code-signed, so Windows shows **"Windows protected your PC"**. Click
   **More info**, then **Run anyway**.
3. Choose **Only for me**, keep the suggested folder (or pick another one) and click **Install**.
   antics starts when setup finishes.

You'll find **antics** on the desktop and in the Start menu. To pin it, right-click either one and choose
**Pin to taskbar** or **Pin to Start**.

There is also a portable .exe that runs without setup (`npm run dist` makes it next to the installer, see
"Build it again"). It isn't published, to keep downloads small: it starts a few seconds slower because it
unpacks itself each time. It keeps its data in the same place as the installed app, so both share the same
connection.

## Connect it to your worker (once)

The app keeps its own connection, separate from your browser's. Do one of these the first time:

- **You already use antics on your phone or in a browser:** in that copy of antics, open ⚙ Settings and
  tap **Copy app link**. Get the link to this PC (for example, message it to yourself) and copy it here.
  Then, in the app, choose **antics → Open my app link (copied)** (Ctrl+L). You can also paste the link into
  the **Connect this app** box. Keep the link private: it's the key to your worker.
- **First time anywhere:** tap **Set it up** and follow the steps. The Hugging Face token page opens in your
  normal browser. Create the token there, copy it, and paste it back into antics.

The connection is saved in `%APPDATA%\antics`. It stays after you close the app, restart Windows or
install a newer version of the app.

## Using it

- **Menu:** *antics* (Open my app link, Reload, Reload everything, Quit), *View* (Back, Forward, Zoom in /
  Zoom out / Actual size, Toggle full screen: F11) and *Help* (About, Open antics in my browser, Developer
  tools). F5 reloads and Ctrl+mouse-wheel zooms.
- **Back:** the mouse's Back and Forward side buttons and Alt+Left / Alt+Right go back and forward through the
  tabs, like in a browser (only within antics).
- **Saving videos:** **Save video** opens a normal Save box that starts in your **Downloads** folder.
  Afterwards, a notification tells you where the file went. Click it to open that folder. You can also
  right-click a video and choose **Save video as…**.
- **Uploading:** **Upload a video** and **Add a song** open the normal Windows file picker. You can also drag files in.
- **Links:** links to other sites (Hugging Face, TikTok and others) open in your normal browser. The
  worker's own video links are saved through the Save box, so the private key in them never ends up in your
  browser history.
- **Microphone, notifications, clipboard:** antics gets these automatically, and only antics. Other sites never do.
- **Only one copy:** opening antics again brings the open window to the front.
- **Window:** antics remembers its size, position and zoom.
- **Offline:** if the site can't load, antics shows a **Retry** screen. It also tries again by itself
  when the internet comes back. Reload always goes back to antics, whatever the window shows.
- **If antics ever moves** (its address forwards to another one, for example after adding a custom domain to
  GitHub Pages): the window says **antics has moved**, with the new address and an **Open it in my browser**
  button. The app only opens the address built into it, so it then needs a new build with the new address.

### What works differently from the phone

- **Notifications** (the "your video is ready" pings and the Posting plan's reminders) don't work in the desktop
  app: Windows apps built on Chromium (Electron) can't receive web push. Settings says so, and there's no Turn on
  button here. Keep them turned on in antics on your phone.
- **Share** isn't available here, so antics saves the file instead (Save video, also on the Post screen). Upload
  it to TikTok from the folder.
- **🎤 Speak:** the browser's own speech-to-text doesn't run in the app, so antics records you and your worker
  writes the text down.

## Uninstall

Go to Windows **Settings → Apps → Installed apps → antics → Uninstall**. This removes the app and its
shortcuts. Your connection stays in `%APPDATA%\antics` in case you reinstall. To remove it too, delete that folder.

## Build it again

You need Node.js 22 and npm.

```bash
cd desktop
npm ci                      # Electron 45.3.2 + electron-builder 26.18.0 (from npm/GitHub)
npm run dist                # dist/antics-Setup-<version>.exe and dist/antics-<version>-portable.exe
```

- **On Windows**, `npm run dist` needs nothing else.
- **On Linux**, electron-builder sets the exe icon and version info itself (with `resedit`). NSIS still has to
  *run* a 32-bit stub to write the uninstaller, so Wine with 32-bit support is required:

  ```bash
  sudo dpkg --add-architecture i386 && sudo apt-get update
  sudo apt-get install --no-install-recommends wine wine64 wine32:i386
  WINEPREFIX=$PWD/.wine USE_SYSTEM_WINE=true CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist
  ```

  The portable .exe needs no Wine.
- If `npm ci` didn't download Electron (no `node_modules/electron/dist`), run `node node_modules/electron/install.js`.
- **Keep Electron up to date.** The app has the Chromium inside Electron, and it doesn't update itself. The site's
  updates reach it at once, but Chromium's security fixes only come with a new build. So check at least once a
  month (`npm view electron dist-tags`, the `45-x-y` tag) and rebuild and reinstall whenever Electron releases a
  45.x patch:
  1. Pin the new version in `package.json` (`"electron": "45.x.y"`), run `npm install`, then `npm ci`.
  2. Raise `version` in `package.json` (e.g. 1.0.2), build, and run the tests.
  3. Publish the setup as `antics-Setup.exe` on this repo's `downloads` branch (Git LFS: the file is over
     GitHub's 100 MB limit for normal files), replacing the old one, so the link stays the same:
     https://github.com/tendha2020-ai/account-shop/raw/downloads/antics-Setup.exe
  4. In `animals/app.js`, raise `DESKTOP_APP.version` to the new version. Older apps then show
     "A new version of the antics app for Windows is ready" with a **Get the new app** button, and Settings in a
     Windows browser links to the new one.

  Installing the new setup over the old one keeps the connection.

### Tests (Linux)

```bash
npm test                                         # rules: links, permissions, file names, window memory
npm i --no-save playwright@1.63.0                # or point PLAYWRIGHT=/path/to/playwright
sudo apt-get install xdotool xvfb                # the real file picker is clicked with xdotool
ANTICS_TEST_ROOT=.. xvfb-run -a node test/e2e.js # the app against a local copy of the site (127.0.0.1:8933/8934;
                                                 # ANTICS_TEST_PORT / ANTICS_TEST_OTHER move them)
npm run dist:linux-dir && xvfb-run -a npm run test:packaged   # the built app (asar + fuses)
```

`ANTICS_URL` points the app at a local copy of the site for tests. The app accepts it only for an
`http://127.0.0.1`, `localhost` or `[::1]` address, so it can't send the app to another site.

## How it's put together

| File | What it does |
| --- | --- |
| `main.js` | The window, menu, single-copy lock, saving files, permissions, offline screen |
| `lib/policy.js` | The rules: what stays in the window, what goes to the browser, what is saved, which permissions |
| `lib/window-state.js` | Remembers size, position, maximized and zoom (`%APPDATA%\antics\window-state.json`) |
| `preload.js` | Gives the page `window.antics = { desktop: true, version }` and nothing else |
| `offline.html` | The "can't load right now" screen with Retry (also "antics has moved", "stopped unexpectedly") |
| `assets/icon.ico`, `assets/icon.png` | The TENDHA2 icon (`.ico` has 16–256 px, made from `animals/brand/icon-512.png`) |
| `test/` | `unit.js` (plain Node), `e2e.js` (Playwright + Electron), `packaged.js` (the built app) |

Security settings: `contextIsolation`, `sandbox` and no `nodeIntegration` in every window; no `<webview>`;
the main window can only navigate inside `/account-shop/animals/` on the site (a page that ends up anywhere else,
such as `about:blank`, is sent back to the site; a second window it opened closes). Microphone, camera,
notifications, clipboard and full screen are allowed only for `https://tendha2020-ai.github.io`, and
every other permission is refused. The session is persistent (`persist:antics`). Electron fuses turn off
running as Node, `NODE_OPTIONS` and `--inspect`, and the app only loads from its `app.asar`.
