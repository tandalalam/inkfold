# Inkfold

A GoodNotes-style notebook app for iPad that runs as an installable web app
(PWA). Handwrite with Apple Pencil, organize notebooks in nested folders, and
write on PDFs. Everything is stored on the device and works offline.

## Features

- **Library**: nested folders, search, sort by date or name, rename / move / duplicate / delete
- **Notebooks**: blank, lined, grid or dotted paper (white or cream), A4 / Letter / square
- **PDFs**: import a PDF as a notebook, or insert PDF pages into an existing notebook
- **Pencil**: pressure-sensitive ballpoint and fountain pens, highlighter, whole-stroke and
  precise eraser, lasso (move / recolor / duplicate / delete)
- **Shape snapping**: hold the Pencil still at the end of a stroke to turn it into a clean
  line, circle/ellipse, rectangle or triangle
- **Gestures**: fingers scroll, pinch to zoom, two-finger tap = undo, three-finger tap = redo.
  Fingers never draw unless "Draw with finger" is on (palm rejection)
- **Pages**: thumbnail sidebar, add / duplicate / reorder / delete, change paper per page
- **Export**: notebook or single page as a PDF with ink flattened in, via the iPad share sheet
- **Backup**: whole library (including PDFs) to one `.zip`; restore merges it back

## Install on iPad

1. Make sure the iPad is connected to Tailscale.
2. In **Safari**, open `https://t3-edna-vps.tailc15cef.ts.net:8460/`
3. Tap **Share → Add to Home Screen**.
4. Open Inkfold from the Home Screen. After the first load it works offline (no Tailscale needed).

Data lives in the Home Screen app's storage on the iPad, tied to the address it
was installed from. Use **Settings (gear) → Back up library** regularly, and use
the backup to move notes if the app's address ever changes.

## Develop

```sh
npm install
npm run dev          # http://127.0.0.1:5173
npm run build        # production build in dist/
npx vite preview --host 127.0.0.1 --port 4173
node tests/e2e.mjs http://127.0.0.1:4173/      # end-to-end test (WebKit + Chromium)
node tests/offline.mjs http://127.0.0.1:4173/  # service-worker / offline test
```

The Tailscale URL serves `dist/` directly (`sudo tailscale serve --bg --https=8460 $PWD/dist`),
so `npm run build` deploys. The installed app picks up the new version the next
time it is opened while online.

## Layout

- `src/lib`: storage (IndexedDB), ink rendering, geometry, shape recognition, PDF render/export, backup
- `src/editor`: notebook editor (pages, Pencil input, gestures, toolbar, sidebar)
- `src/library`: folders and notebooks screen
- `src/ui`: dialogs, menus, toasts
