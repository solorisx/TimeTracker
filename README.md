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

## Browser support

| Browser            | Storage mode                                              |
| ------------------ | -------------------------------------------------------- |
| Edge / Chrome      | Full file sync via the File System Access API (recommended) |
| Firefox / Safari   | Falls back to in-browser storage + **Export / Import JSON** buttons |

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
