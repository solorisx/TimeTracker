# ⏱ Time Tracker

A simple, dependency-free time tracker for projects, your thesis, study subjects — anything.
Create projects, run a start/stop timer, or log time manually. It's a single static web page
(no server, no build, no installation) that stores everything in **one JSON file** you keep in
a cloud-synced folder, so you can use it from any computer.

## Features

- Create color-coded projects (archive or delete them later)
- Start/stop timer that keeps running even if you reload the page
- Add time manually (date + `hh:mm` + note)
- Notes/descriptions on every entry
- Edit and delete entries
- Summary with totals per project (Today / This week / This month / All time)
- Cross-computer access via a JSON file in your cloud folder (OneDrive, Dropbox, Google Drive…)

## Setup

1. Put `index.html`, `styles.css`, and `app.js` together in a folder inside your cloud-synced
   directory (e.g. `OneDrive\TimeTracker\`).
2. Open `index.html` in **Microsoft Edge or Google Chrome** (double-click it).
3. Click **Connect data file** and create (or select) a file named `timetracker.json` **in the
   same cloud folder**. The app now auto-saves to that file after every change.
4. On another computer, open the same `index.html` and connect to the same `timetracker.json` —
   your data is there.

> The first time you connect on each computer, the browser asks permission to access the file.
> After that it reconnects automatically when you reopen the page (one permission click may be
> required after a browser restart).

## Google Drive sync (recommended for mobile + GitHub Pages)

The local-file mode above relies on the browser's File System Access API, which **does not work
on mobile browsers** and **hangs on some Linux setups** when the file lives on a Google Drive /
network mount. For phones, tablets, or when hosting the app on GitHub Pages, use **native Google
Drive sync** instead: the app stores a single `timetracker.json` in your Drive and talks to the
Drive API directly — no local file, works identically on desktop and mobile, and reconnects
automatically after a reload.

It needs a one-time, free Google Cloud setup to get an **OAuth Client ID** (this ID is not a
secret — it ships in the page):

1. Go to <https://console.cloud.google.com/> and create a project (any name).
2. **APIs & Services → Library →** enable the **Google Drive API**.
3. **APIs & Services → OAuth consent screen:** choose **External**, fill in the app name and your
   email. Under **Audience**, add your own Google account as a **Test user** (no Google
   verification is needed — the `drive.file` scope only lets the app touch the one file it
   creates).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**
   Under **Authorized JavaScript origins** add the exact origin(s) you'll open the app from:
   - `https://<your-username>.github.io` for GitHub Pages (the path after the host doesn't matter)
   - `http://localhost:8000` (or whatever port) for local testing
5. Copy the generated **Client ID** and paste it into [`config.js`](config.js):
   ```js
   window.TT_CONFIG = { googleClientId: "1234567890-abc123.apps.googleusercontent.com" };
   ```
6. Reload the app and click **Connect Google Drive**, then sign in. After that it reconnects
   silently on every reload (on mobile too). On a fresh device, click the button once to authorize.

> Hosting on GitHub Pages? Just commit your `config.js` with the Client ID and push — since the
> Client ID isn't secret and the origin is locked down to your Pages domain, this is safe.

## Browser support

| Browser            | Storage mode                                              |
| ------------------ | -------------------------------------------------------- |
| Any browser        | **Google Drive sync** once a Client ID is configured (best for mobile) |
| Edge / Chrome      | Local file sync via the File System Access API (desktop only) |
| Firefox / Safari   | In-browser storage + **Export / Import JSON** buttons |

In the fallback mode, data lives in that browser only. Use **Export JSON** to save a backup to
your cloud folder and **Import JSON** to load it on another machine.

## How cross-computer sync works (and its one caveat)

Your cloud service (OneDrive/Dropbox/etc.) syncs `timetracker.json` between computers like any
other file. The app reads it on load and writes it on every change.

**Caveat:** if you edit on two computers at the same time (or before sync finishes), the cloud
service may create a *conflict copy* of the file. To avoid this:

- Stop the timer and let sync settle before switching computers.
- Use the **Reload from file** button to pull in changes made elsewhere before you start editing.

This is fine for normal single-user use. (For a heavier multi-device setup you'd want a real
database/server, which is out of scope for this simple tool.)

## Data format

`timetracker.json` is plain, human-readable JSON:

```json
{
  "version": 1,
  "projects": [
    { "id": "…", "name": "Master Thesis", "color": "#4f86f7", "createdAt": "…", "archived": false }
  ],
  "entries": [
    { "id": "…", "projectId": "…", "start": "…", "end": "…", "durationSec": 3600, "note": "wrote intro" }
  ],
  "running": null
}
```

You can safely back it up, inspect it, or edit it by hand.
