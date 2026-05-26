# Photo Importer — Spec (v1)

A minimal Linux importer for the iPhone Camera Roll. Plug in the
phone, see a thumbnail grid of everything on it, multi-select, choose
a destination, optionally transcode HEIC to JPEG, and batch-copy.
**The product is the calm** — the bar is Apple's Image Capture, minus
the menu bar and the "are you sure" dialogs.

v1 imports from iPhone over USB. Generic camera / MTP support is
explicitly deferred — naming the app `photo-importer` hedges the slug
for the future without committing to the abstraction now.

## In one sentence

**Plug in your iPhone, pick photos and videos to keep, batch-save them
to a Linux folder.**

## Identity

| Where                | Value                                            |
|----------------------|--------------------------------------------------|
| Slug                 | `photo-importer`                                  |
| Binary               | `krill-photo-importer`                            |
| Cargo package        | `krill-photo-importer`                            |
| Cargo lib            | `krill_photo_importer_lib`                        |
| `package.json` name  | `krill-photo-importer`                            |
| Bundle identifier    | `software.krill.photo-importer`                   |
| productName          | `Photo Importer`                                  |
| State dir            | `$XDG_STATE_HOME/krill-photo-importer/`           |
| Cache dir            | `$XDG_CACHE_HOME/krill-photo-importer/`           |
| GitHub repo          | `krill-software/photo-importer`                   |
| Lucide icon          | `image-down`                                     |

## Hard safety guarantee — **read-only against the iPhone**

The app **never deletes, modifies, moves, or renames anything on the
iPhone, in any version**. The `ifuse` mount is treated as strictly
read-only: we open files for reading and pull bytes, we do not call
any write or unlink operation against the mounted filesystem. Imports
*copy* — the original stays put on the phone.

This isn't a "v1 doesn't support delete yet" thing. It is a baseline
invariant of the app: even if a future milestone someday adds "bulk
delete from device after import," that would be a separate codepath
behind explicit confirmation; nothing in the current core flow is
allowed to touch the phone's storage destructively.

## Does this fit krill?

Yes — single-purpose, no settings panel beyond a default-folder
override (familiar from file-drop), no accounts, no cloud, no daemon.
The whole flow is mouse-arrows-and-Tab through one screen.

The honest tension is the runtime dependencies — libimobiledevice +
libheif on the host. We document them as install steps; same shape as
file-drop needing wl-clipboard or xclip.

## Architecture

### Wire shape

```
+---- Sidebar (260px) -----+-------- Main pane -----------------+
|                          | [refresh]  iPhone "Filip's Phone"  |
|  [device thumbnail]      |                                    |
|  Filip's Phone           |  ┌─────┬─────┬─────┬─────┐         |
|                          |  │ img │ img │ img │ img │   ...   |
|  ─────────────           |  └─────┴─────┴─────┴─────┘         |
|  All           1,247     |  ┌─────┬─────┬─────┬─────┐         |
|  Photos        1,194     |  │ img │ img │ img │ img │         |
|  Videos           53     |  └─────┴─────┴─────┴─────┘         |
|                          |  ...                               |
|  ─────────────           |                                    |
|                          |                                    |
|  Last import:            |  ┌────────────────────────────┐    |
|  ~/Pictures/iPhone       |  │ 12 selected · 84.3 MB      │    |
|                          |  │ [ keep / transcode ▾ ]     │    |
|  v0.1.0                  |  │ [ Choose folder & import ] │    |
+--------------------------+----+-------------------------------+
```

Shell-family layout (same family as file-drop): no titlebar, no status
line, window controls on the right of the main pane, drag region
across the top, hamburger top-left of sidebar, version pinned bottom
of sidebar.

### Transport

- **Detection.** `idevice_id -l` to list paired devices; `ideviceinfo`
  for the device's display name.
- **Browsing.** Mount the iPhone's Camera Roll via `ifuse` to a temp
  directory under `$XDG_CACHE_HOME/krill-photo-importer/mount/`. The
  Camera Roll lives at `/DCIM/{100,101,…}APPLE/`.
- **Reading.** Plain `tokio::fs` against the FUSE mount; no AFC
  protocol handling in our code.
- **Trust.** First connect requires the user to tap "Trust This
  Computer" on the iPhone. If `idevice_id` shows the device but
  `ifuse` fails with `ERROR: Pairing protocol failed`, surface a
  banner: "Tap *Trust* on your iPhone, then click *Refresh*."

### Thumbnails

- **Source.** Decode HEIC / JPEG / MOV first-frame on the host. For
  HEIC, use `libheif-rs` (FFI bindings to system `libheif`). Videos:
  pull the first frame via `ffmpeg -ss 0 -frames:v 1` — defer if no
  ffmpeg installed.
- **Generation.** Decode at 256×256 max, write to
  `$XDG_CACHE_HOME/krill-photo-importer/thumbs/<sha256>.jpg`. Keyed by
  the file's path + mtime hash so re-imports skip re-decoding.
- **Pace.** Generate lazily as cells scroll into view; a small worker
  pool (≤ 4 concurrent) to keep the UI responsive.
- **Graceful fallback.** If libheif missing at runtime, HEIC cells show
  a generic icon + filename; non-HEIC cells still get real thumbnails.

### Format conversion

- **Default.** Copy bytes verbatim — `IMG_1234.HEIC` lands as `IMG_1234.HEIC`.
- **Optional HEIC → JPEG.** A single dropdown above the Import button:
  "Keep originals" (default) or "Convert HEIC → JPEG (quality 90)".
  Applied uniformly to the batch; no per-file knob.
- **Videos.** Always copied as-is. No transcode.
- **Live Photos.** v1 imports the still only (the `.HEIC` half).
  The paired `.MOV` is recognized and shown with a small "Live" badge,
  but isn't pulled. M3 covers the both-halves option.

### Filesystem

- **Destination.** Per-import folder picker (Tauri dialog plugin,
  `directory: true`). Remembered between launches as "last used
  folder," shown in the sidebar.
- **Conflict policy.** Never overwrite. On collision, suffix with
  `(2)`, `(3)`, etc. — same policy file-drop already uses.
- **Atomicity.** Per-file copy to `.<name>.partial` then rename on
  success. A canceled or crashed import leaves `.partial` files that
  the next import sweeps if found.

## State files

- `$XDG_STATE_HOME/krill-photo-importer/settings.json`
  - `lastDestinationFolder`: string
  - `conversionMode`: `"keep" | "heic-to-jpeg"`
  - `jpegQuality`: number (1–100, default 90)
- `$XDG_CACHE_HOME/krill-photo-importer/thumbs/`
  - Per-file `<sha256>.jpg` thumbnails. Disposable.
- `$XDG_CACHE_HOME/krill-photo-importer/mount/`
  - The active ifuse mountpoint while the app runs. Unmounted on quit.

No history sidecar in v1 — the OS file manager is the history.

## The flow as users see it

1. **Open the app.** Sidebar shows "No iPhone connected" with a refresh icon.
2. **Plug iPhone in via USB.** Click Refresh (or the app auto-detects
   on a short polling interval). Sidebar populates with the device
   name and counts.
3. **(First connect only.)** Banner appears: "Tap *Trust* on your
   iPhone, then click *Refresh*." After trusting and refreshing, the
   thumbnail grid populates.
4. **Browse the grid.** Click to select / shift-click for range /
   ctrl-click to toggle. Selected cells get an accent border + check.
5. **Sidebar filter** (Photos / Videos / All) narrows the grid.
6. **Pick conversion** in the dropdown above Import (default: keep).
7. **Click Import.** Folder picker → choose destination → progress
   bar overlays the grid → done. Imported cells get a faded "✓"
   overlay so you can keep going without losing track.

## What v1 is

- USB-only iPhone import. Mounted via system `ifuse`.
- Thumbnail grid with HEIC + JPEG + video first-frame previews
  (libheif + ffmpeg on host).
- Multi-select with shift / ctrl ranges.
- Sidebar filter Photos / Videos / All.
- HEIC → JPEG transcode option (quality 90).
- Folder picker per import; remembered between launches.
- Live Photos *recognized* and badged, still-only import.
- Linux x86_64. Tauri 2 + TypeScript + Rust. Shell-family chrome.

## What v1 is *not*

- **No Android / generic MTP / PTP cameras.** iPhone-only. The slug
  hedges naming for v2; no abstraction in v1.
- **No wireless transfer.** AirDrop is closed; no
  `opendrop`/`owl`-style integration. If you want wireless, that's
  file-drop's job.
- **No editing, rotating, cropping.** Import only. The image-editor
  lives next door for that.
- **No iCloud / cloud sources.** Local device only.
- **No deletion / modification / rename of anything on the iPhone, ever**
  (see *Hard safety guarantee* above). Including the obvious case of
  "delete from phone after import" — explicitly off the table for v1
  and not on the M1–M6 roadmap.
- **No live preview of full image on click.** Thumbnail grid only.
  Open the imported file in image-viewer if you want that.
- **No videos in M1.** M3 adds them; M1 lists + imports photos.
- **No Live Photos `.MOV` half.** M3 adds the both-halves option.
- **No iOS companion app.** That's the file-drop-iOS sibling project.

## Future (deferred decisions, not roadmap)

- **Android / MTP support.** Likely a separate `android-photos`
  project sharing a small "thumbnail grid + multi-select" Rust crate.
- **Cloud sources** (Google Photos, iCloud download). Out of scope —
  fundamentally accountful, not krill.
- **AVIF transcode option** alongside JPEG. Useful when the
  destination is a HEIF-aware static site or modern browsers; v2.
- **Bulk delete from device** after successful import, behind a
  destructive confirmation banner. Possible, scary.
- **Bulk rename on import** (timestamp-prefixed filenames). One of
  those quiet conveniences worth considering once we use the app.

## Stack

- **Transport:** `libimobiledevice` + `ifuse` (system packages,
  `apt install libimobiledevice-utils ifuse` on Debian / Ubuntu).
  Shelled out via `std::process::Command` — no Rust FFI layer.
- **Thumbnails:** `libheif-rs` (FFI to system `libheif`) for HEIC.
  `image` crate for JPEG / PNG. `ffmpeg` shelled out for video first
  frames (M3).
- **State:** `krill-desktop-core` for XDG dirs + window state.
- **Chrome:** `@krill-software/desktop-ui` (`mountChrome` with the
  shell-family overrides we worked out for file-drop).
- **UI:** plain TypeScript + Vite. Virtualized grid (only render
  visible thumbnails) — same constraint csv-editor solved for rows.

## Runtime dependencies (host)

| Package         | Why                                  | Linux install                           |
|-----------------|--------------------------------------|------------------------------------------|
| libimobiledevice| iPhone USB protocol (`idevice_id`)   | `apt install libimobiledevice-utils`     |
| ifuse           | Mount iPhone DCIM as a filesystem    | `apt install ifuse`                      |
| libheif         | Decode HEIC for thumbnails           | `apt install libheif1` (often preinstalled) |
| ffmpeg          | Video first-frame thumbnails (M3+)   | `apt install ffmpeg`                     |

Document in README and the docs landing page. Missing libheif degrades
gracefully (HEIC cells get a generic icon); missing ifuse hard-blocks
listing with a clear error banner.

## Milestones

- **M1 — Device + list.** Scaffold the app (shell-family layout, no
  titlebar / status line, sidebar + main). Backend: detect iPhone via
  `idevice_id`, surface its name. Mount via `ifuse`. List DCIM files
  as filename + size + mtime in a simple table (no thumbnails yet).
  No selection, no import. Goal: prove the libimobiledevice + ifuse
  pipeline + the shell layout.
- **M2 — Thumbnail grid.** Replace the table with a virtualized grid.
  Lazy thumbnail generation via libheif-rs, cached under XDG cache.
  Multi-select (click / shift-click range / ctrl-click toggle).
  Selection count + total size shown above the (still-stubbed) Import
  button.
- **M3 — Import flow.** Folder picker. Batch copy with progress.
  Conflict resolution (`(2)`, `(3)`). Atomic `.partial` rename.
  "Last destination" remembered in `settings.json`. Sidebar filter
  Photos / Videos / All.
- **M4 — Format conversion.** "Keep originals" / "Convert HEIC → JPEG"
  dropdown above Import. JPEG quality default 90. Videos always copy.
- **M5 — Videos + Live Photos.** Pull video first frames via ffmpeg.
  Live Photos paired detection + "Live" badge. Still-only import in
  v1, both-halves option as a setting.
- **M6 — Polish & packaging.** Trust-prompt detection banner. README
  with full system-deps install. AppImage + .deb. Updater wiring
  (existing org pubkey). Per-app docs landing page (rich style, shell
  chrome.css).

Each milestone is a green commit and a checkpoint. M1 alone is a real
chunk because it's the new-ground milestone (libimobiledevice + ifuse).
