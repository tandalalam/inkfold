# Inkfold

A GoodNotes-style notebook app for iPad that runs as an installable web app
(PWA). Handwrite with Apple Pencil, organize notebooks in nested folders, and
write on PDFs. Everything is stored on the device and works offline.

## Features

- **Library**: nested folders, search, sort by date or name, rename / move / duplicate / delete
- **Notebooks**: blank, lined, grid or dotted paper (white or cream), A4 / Letter / square
- **PDFs**: import a PDF as a notebook, or insert PDF pages into an existing notebook
- **Pencil**: pressure-sensitive ballpoint and fountain pens, highlighter, whole-stroke and
  precise eraser, lasso (move / recolor / copy / cut / delete)
- **Copy & paste ink**: copy a lasso selection, then tap any page (in any notebook) with the
  lasso and choose Paste, or use the toolbar Paste button
- **Pen/eraser switch**: a floating button (or the E key) flips between the pen and the eraser.
  Safari doesn't expose the Apple Pencil double-tap to web apps, so this stands in for it
- **Shape snapping**: hold the Pencil still at the end of a stroke to turn it into a clean
  line, circle/ellipse, rectangle or triangle
- **Gestures**: fingers scroll, pinch to zoom, two-finger tap = undo, three-finger tap = redo.
  Fingers never draw unless "Draw with finger" is on (palm rejection)
- **Pages**: thumbnail sidebar, add / duplicate / reorder / delete, change paper per page
- **Export**: notebook or single page as a PDF with ink flattened in, via the iPad share sheet
- **Backup**: whole library (including PDFs) to one `.zip`; restore merges it back
- **Ask (private)**: lasso anything (ink or printed PDF text), tap Ask, collect several
  selections, and send a question to a T3 Code thread. Answers come back with Markdown and
  LaTeX typeset. This needs the owner's private bridge (`server/`), reachable only on their
  tailnet. Turn it on under Settings → Turn on assistant

## Install on iPad

1. In **Safari**, open **https://tandalalam.github.io/inkfold/**
2. Tap **Share → Add to Home Screen**.
3. Open Inkfold from the Home Screen. After the first load it works offline.

Every push to `main` rebuilds and redeploys the site (GitHub Actions → Pages); the
installed app picks up the new version the next time it is opened online.

A private copy is also served on the tailnet at `https://t3-edna-vps.tailc15cef.ts.net:8460/`
(`sudo tailscale serve --bg --https=8460 $PWD/dist`, updated by `npm run build`).

Data lives in the Home Screen app's storage on the iPad and is tied to the address
it was installed from (each address above has its own separate notes). Use
**Settings (gear) → Back up library** regularly, and back up / restore to move
notes between addresses.

## Develop

```sh
npm install
npm run dev          # http://127.0.0.1:5173
npm run build        # production build in dist/
npx vite preview --host 127.0.0.1 --port 4173
node tests/e2e.mjs http://127.0.0.1:4173/      # end-to-end test (WebKit + Chromium)
node tests/offline.mjs http://127.0.0.1:4173/  # service-worker / offline test
node tests/ask.mjs http://127.0.0.1:4173/      # copy/paste, Pencil taps, Ask (fake bridge)
```


## Layout

- `src/lib`: storage (IndexedDB), ink rendering, geometry, shape recognition, PDF render/export, backup
- `src/editor`: notebook editor (pages, Pencil input, gestures, toolbar, sidebar)
- `src/library`: folders and notebooks screen
- `src/ui`: dialogs, menus, toasts
- `src/ask`: Ask panel, clip rendering, Markdown + KaTeX answers, bridge client
- `server`: the private bridge to T3 Code (see `server/README.md`)
