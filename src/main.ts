import "@krill-software/desktop-ui/styles";
import "./styles.css";
import { mountChrome, showBootError, checkForUpdates } from "@krill-software/desktop-ui";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icons as lucideIcons, createElement as createLucide } from "lucide";

// ---- Types (mirror Rust) -------------------------------------------

interface Device { udid: string; name: string }
type DeviceState =
  | { kind: "none" }
  | { kind: "needs-trust"; device: Device; hint: string }
  | { kind: "ready"; device: Device };

interface EnvCheck {
  idevice_id: boolean;
  ifuse: boolean;
  fusermount: boolean;
  usbmuxd_running: boolean;
}

interface MediaItem {
  name: string;
  path: string;
  ext: string;
  size: number;
  modified_ms: number;
  kind: "image" | "video" | "other";
}

// ---- Lucide ---------------------------------------------------------

function pascal(name: string): string {
  return name.split("-").map((s) => s[0].toUpperCase() + s.slice(1)).join("");
}
function iconSvg(name: string, size = 16): SVGElement {
  const node = (lucideIcons as Record<string, any>)[pascal(name)] ?? lucideIcons.Image;
  const el = createLucide(node);
  el.setAttribute("width", String(size));
  el.setAttribute("height", String(size));
  return el;
}

// ---- DOM helpers ---------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---- App state ------------------------------------------------------

let viewportEl: HTMLElement;
let mainContentEl: HTMLElement;
let auxEl: HTMLElement;
let device: DeviceState = { kind: "none" };
let media: MediaItem[] = [];
let env: EnvCheck | null = null;
let refreshing = false;
/// True while list_media is still streaming media-batch events. Distinct
/// from `refreshing` — the env/device/mount steps finish quickly, then
/// the walk can take many seconds for a 50 GB library.
let listing = false;
/// Schedule incremental re-renders without thrashing on every batch.
let pendingRender = 0;

type FilterKind = "image" | "video";
let filter: FilterKind = "image";

interface ImportStatus {
  phase: "started" | "copying" | "done" | "error";
  current?: number;
  copied?: number;
  total?: number;
  totalBytes?: number;
  bytesCopied?: number;
  name?: string;
  error?: string;
}
let importStatus: ImportStatus | null = null;
let lastDestination: string | null = null;

// ---- Main topbar (window controls + drag region) -------------------

function buildMainTopbar(): HTMLElement {
  const bar = el("div", { class: "main-topbar", "data-tauri-drag-region": "true" });
  const min = el("button", { class: "main-topbar-btn", type: "button", title: "Minimize" });
  min.append(iconSvg("minus", 16));
  min.addEventListener("click", () => { void getCurrentWindow().minimize(); });
  const max = el("button", { class: "main-topbar-btn", type: "button", title: "Maximize" });
  max.append(iconSvg("square", 14));
  max.addEventListener("click", () => { void getCurrentWindow().toggleMaximize(); });
  const close = el("button", { class: "main-topbar-btn", type: "button", title: "Close", "data-kind": "close" });
  close.append(iconSvg("x", 16));
  close.addEventListener("click", () => { void getCurrentWindow().close(); });
  bar.append(min, max, close);
  return bar;
}

function buildAuxTopbar(): HTMLElement {
  const bar = el("div", { class: "aux-topbar", "data-tauri-drag-region": "true" });
  const hamburger = el("button", { class: "main-topbar-btn", type: "button", title: "Menu" });
  hamburger.append(iconSvg("menu", 16));
  hamburger.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleHamburgerMenu(bar);
  });
  bar.append(hamburger);
  return bar;
}

function toggleHamburgerMenu(anchor: HTMLElement) {
  const existing = document.querySelector(".menu-popover");
  if (existing) { existing.remove(); return; }
  const pop = el("div", { class: "menu-popover" });
  const items: Array<{ label: string; action: () => void } | { sep: true }> = [
    { label: "Check for updates…", action: () => void checkForUpdates("Photo Importer") },
    { sep: true },
    { label: "Quit", action: () => void getCurrentWindow().close() },
  ];
  for (const it of items) {
    if ("sep" in it) {
      pop.append(el("div", { class: "menu-popover-sep" }));
    } else {
      const btn = el("button", { class: "menu-popover-item", type: "button" }, it.label);
      btn.addEventListener("click", () => { pop.remove(); it.action(); });
      pop.append(btn);
    }
  }
  anchor.parentElement?.append(pop);
  setTimeout(() => {
    const handler = (ev: MouseEvent) => {
      if (!pop.contains(ev.target as Node)) {
        pop.remove();
        document.removeEventListener("click", handler);
      }
    };
    document.addEventListener("click", handler);
  }, 0);
}

// ---- Sidebar --------------------------------------------------------

function renderAux() {
  auxEl.replaceChildren();
  auxEl.append(buildAuxTopbar());

  // Device card. Click to re-scan when empty; right-aligned sync button
  // when a device is ready.
  const isClickable = device.kind === "none" && !refreshing && envOk(env ?? {} as EnvCheck);
  const deviceCard = el(isClickable ? "button" : "div", {
    class: "device-card",
    ...(isClickable ? { type: "button", title: "Look for devices again" } : {}),
  });
  if (isClickable) {
    deviceCard.addEventListener("click", () => { if (!refreshing) void refresh(); });
  }
  const visual = el("div", { class: "device-visual" });
  visual.append(iconSvg("smartphone", 24));
  deviceCard.append(visual);
  const text = el("div", { class: "device-text" });
  if (env && !envOk(env)) {
    text.append(el("div", { class: "device-name muted" }, "Setup needed"));
    text.append(el("div", { class: "device-sub" }, "Install missing tools first"));
  } else if (device.kind === "none" && refreshing) {
    text.append(el("div", { class: "device-name muted" }, "Looking for devices…"));
  } else {
    switch (device.kind) {
      case "none":
        text.append(el("div", { class: "device-name muted" }, "No devices found"));
        text.append(el("div", { class: "device-sub" }, "Plug a device in via USB"));
        break;
      case "needs-trust":
        text.append(el("div", { class: "device-name" }, device.device.name));
        text.append(el("div", { class: "device-sub" }, "Tap Trust on the iPhone"));
        break;
      case "ready":
        text.append(el("div", { class: "device-name" }, device.device.name));
        text.append(el("div", { class: "device-sub" }, refreshing ? "syncing…" : "connected"));
        break;
    }
  }
  deviceCard.append(text);

  // Per-device sync button — visible only when a device is ready.
  if (device.kind === "ready") {
    const syncBtn = el("button", {
      class: "device-sync",
      type: "button",
      title: refreshing ? "Syncing…" : "Sync this device",
      ...(refreshing ? { disabled: "" } : {}),
    });
    if (refreshing) syncBtn.setAttribute("data-refreshing", "true");
    const syncIcon = iconSvg("refresh-cw", 14);
    // Spin via desktop-ui's shared loader animation rather than a
    // bespoke @keyframes (see CLAUDE.md → Shared UI components).
    if (refreshing) syncIcon.classList.add("fm-loader-icon");
    syncBtn.append(syncIcon);
    syncBtn.append(el("span", {}, refreshing ? "syncing…" : "sync"));
    syncBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!refreshing) void refresh();
    });
    deviceCard.append(syncBtn);
  }

  auxEl.append(deviceCard);

  // Filter tabs (only when there's media to filter)
  if (device.kind === "ready" && media.length > 0) {
    const tabs = el("div", { class: "filter-tabs" });
    const photos = media.filter((m) => m.kind === "image").length;
    const videos = media.filter((m) => m.kind === "video").length;
    const rows: Array<[FilterKind, string, number]> = [
      ["image", "Photos", photos],
      ["video", "Videos", videos],
    ];
    for (const [kind, label, count] of rows) {
      const tab = el("button", {
        class: "filter-tab",
        type: "button",
        "data-active": filter === kind ? "true" : "false",
      });
      tab.append(el("span", { class: "filter-label" }, label));
      tab.append(el("span", { class: "filter-count" }, String(count)));
      tab.addEventListener("click", () => {
        if (filter === kind) return;
        filter = kind;
        // Filter changes invalidate the anchor since visible indices shift.
        anchorIndex = -1;
        renderAux();
        renderMain();
      });
      tabs.append(tab);
    }
    auxEl.append(tabs);
  }

  // Spacer + version footer
  auxEl.append(el("div", { class: "aux-version" }, `v${__APP_VERSION__}`));
}

// ---- Main pane ------------------------------------------------------

function renderMain() {
  const root = el("div", { class: "main" });

  // Env check takes priority — if anything's missing, no point talking
  // about devices yet.
  if (env && !envOk(env)) {
    root.append(buildEnvChecklist(env));
    mainContentEl.replaceChildren(root);
    return;
  }

  // Device state UI.
  switch (device.kind) {
    case "none":
      root.append(buildEmptyState(
        "Plug in your iPhone",
        "Connect via USB cable. The first time, your iPhone will ask you to trust this computer.",
      ));
      break;
    case "needs-trust":
      root.append(buildBanner("info", device.hint));
      break;
    case "ready":
      if (media.length === 0) {
        if (listing) {
          root.append(buildEmptyState(
            "Listing iPhone media…",
            "Walking /DCIM/ over USB. First batch will appear shortly.",
          ));
        } else {
          root.append(buildEmptyState(
            "No media found",
            "Your iPhone is connected but /DCIM/ is empty.",
          ));
        }
      } else {
        root.append(buildMediaTable());
      }
      break;
  }

  mainContentEl.replaceChildren(root);
}

function envOk(e: EnvCheck): boolean {
  return e.idevice_id && e.ifuse && e.fusermount && e.usbmuxd_running;
}

interface EnvItem {
  key: keyof EnvCheck;
  label: string;
  why: string;
  fix: string;
}

const ENV_ITEMS: EnvItem[] = [
  {
    key: "idevice_id",
    label: "libimobiledevice",
    why: "Talks to your iPhone over USB.",
    fix: "sudo apt install libimobiledevice-utils",
  },
  {
    key: "ifuse",
    label: "ifuse",
    why: "Mounts the iPhone's Camera Roll as a filesystem.",
    fix: "sudo apt install ifuse",
  },
  {
    key: "fusermount",
    label: "FUSE",
    why: "Userspace filesystem support — needed by ifuse to mount.",
    fix: "sudo apt install fuse",
  },
  {
    key: "usbmuxd_running",
    label: "usbmuxd",
    why: "Daemon that bridges USB to the iPhone protocol. Usually auto-starts after install.",
    fix: "sudo apt install usbmuxd && sudo systemctl start usbmuxd",
  },
];

function buildEnvChecklist(e: EnvCheck): HTMLElement {
  const wrap = el("section", { class: "env-section" });
  wrap.append(el("h2", { class: "env-title" }, "Set up the dependencies"));
  wrap.append(el("p", { class: "env-lede" },
    "Photo Importer leans on a few system tools to talk to the iPhone. Anything ✓ is already installed."));

  const list = el("div", { class: "env-list" });
  for (const item of ENV_ITEMS) {
    const ok = e[item.key];
    const row = el("div", { class: "env-row", "data-ok": ok ? "true" : "false" });

    const status = el("div", { class: "env-status" });
    status.append(iconSvg(ok ? "check" : "x", 16));
    row.append(status);

    const text = el("div", { class: "env-text" });
    text.append(el("div", { class: "env-label" }, item.label));
    text.append(el("div", { class: "env-why" }, item.why));
    if (!ok) {
      const fixRow = el("div", { class: "env-fix-row" });
      const fix = el("code", { class: "env-fix" }, item.fix);
      const copy = el("button", { class: "env-fix-copy", type: "button", title: "Copy command" });
      copy.append(iconSvg("copy", 12));
      copy.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        try {
          await navigator.clipboard.writeText(item.fix);
          copy.replaceChildren(iconSvg("check", 12));
          setTimeout(() => copy.replaceChildren(iconSvg("copy", 12)), 1200);
        } catch { /* ignore */ }
      });
      fixRow.append(fix, copy);
      text.append(fixRow);
    }
    row.append(text);

    list.append(row);
  }
  wrap.append(list);

  const refreshHint = el("p", { class: "env-refresh-hint" },
    "After installing, click ");
  const refreshLink = el("button", { class: "env-refresh-link", type: "button" }, "Refresh");
  refreshLink.addEventListener("click", () => void refresh());
  refreshHint.append(refreshLink, document.createTextNode("."));
  wrap.append(refreshHint);

  return wrap;
}

function buildBanner(kind: "info" | "error", ...children: (Node | string)[]): HTMLElement {
  const b = el("div", { class: `banner ${kind}` });
  b.append(...children.map((c) => typeof c === "string" ? el("p", {}, c) : c));
  return b;
}

function buildEmptyState(title: string, body: string): HTMLElement {
  const e = el("div", { class: "empty-state" });
  e.append(iconSvg("smartphone", 56));
  e.append(el("h2", {}, title));
  e.append(el("p", {}, body));
  return e;
}

// --- Multi-select state -----------------------------------------------
//
// Anchor = the last cell clicked without modifiers; shift-click extends a
// range from anchor to the clicked cell (inclusive). Ctrl-click toggles
// just the clicked cell without moving the anchor. Plain click selects
// only the clicked cell and resets the anchor. Background click clears.

const selected = new Set<string>();
let anchorIndex = -1;

function clearSelection() {
  if (selected.size === 0) return;
  selected.clear();
  anchorIndex = -1;
  refreshSelectionView();
}

function refreshSelectionView() {
  // Toggle data-selected on each rendered cell + repaint the footer
  // bar without rebuilding the entire grid.
  const grid = mainContentEl.querySelector(".media-grid");
  if (grid) {
    for (const cell of grid.querySelectorAll<HTMLElement>(".media-cell")) {
      const p = cell.dataset.path!;
      if (selected.has(p)) cell.setAttribute("data-selected", "true");
      else cell.removeAttribute("data-selected");
    }
  }
  paintFooter();
}

function paintFooter() {
  const footer = mainContentEl.querySelector(".media-footer");
  if (!footer) return;
  const summary = footer.querySelector(".footer-summary")!;
  const totalBytes = media.reduce((a, m) => a + m.size, 0);
  if (selected.size > 0) {
    const selBytes = media
      .filter((m) => selected.has(m.path))
      .reduce((a, m) => a + m.size, 0);
    summary.textContent = `${selected.size} of ${media.length} selected · ${formatBytes(selBytes)}`;
    summary.setAttribute("data-mode", "selection");
  } else if (listing) {
    summary.textContent = `Listing… ${media.length} so far · ${formatBytes(totalBytes)}`;
    summary.setAttribute("data-mode", "listing");
  } else {
    summary.textContent = `${media.length} item${media.length === 1 ? "" : "s"} on device · ${formatBytes(totalBytes)}`;
    summary.removeAttribute("data-mode");
  }
  const importBtn = footer.querySelector<HTMLButtonElement>(".import-btn");
  if (importBtn) {
    const importing = importStatus?.phase === "started" || importStatus?.phase === "copying";
    importBtn.disabled = selected.size === 0 || importing;
    importBtn.textContent = selected.size > 0
      ? `Import ${selected.size}…`
      : "Import";
  }
}

async function startImport() {
  if (selected.size === 0) return;
  if (importStatus?.phase === "started" || importStatus?.phase === "copying") return;
  let dest: string | null = null;
  try {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: lastDestination ?? undefined,
      title: `Import ${selected.size} item${selected.size === 1 ? "" : "s"} to…`,
    });
    if (typeof picked !== "string" || !picked) return;
    dest = picked;
  } catch (e) {
    console.warn("folder picker failed:", e);
    return;
  }

  // Snapshot the selection in the order it appears in `media`, so the
  // progress overlay's "N of M" follows the same visual ordering.
  const paths = media.filter((m) => selected.has(m.path)).map((m) => m.path);

  importStatus = { phase: "started", total: paths.length };
  renderMain(); // overlay appears

  try {
    await invoke("import_files", { paths, dest });
    // Backend already emitted phase=done; renderMain'll have refreshed.
    selected.clear();
    anchorIndex = -1;
    lastDestination = dest;
  } catch (e) {
    console.error("import_files failed:", e);
    // Backend already emitted phase=error too; leave that visible.
  }
}

function buildImportOverlay(): HTMLElement | null {
  if (!importStatus) return null;
  const s = importStatus;
  const overlay = el("div", { class: "import-overlay", "data-phase": s.phase });
  if (s.phase === "started") {
    overlay.append(el("div", { class: "import-row" },
      el("strong", {}, `Importing ${s.total} item${s.total === 1 ? "" : "s"}…`),
    ));
  } else if (s.phase === "copying") {
    const pct = s.totalBytes && s.bytesCopied != null
      ? Math.min(100, Math.floor((s.bytesCopied / s.totalBytes) * 100))
      : 0;
    overlay.append(el("div", { class: "import-row" },
      el("strong", {}, `Importing ${s.current} of ${s.total}`),
      el("span", { class: "import-name" }, s.name ?? ""),
    ));
    const bar = el("div", { class: "import-bar" });
    const fill = el("div", { class: "import-bar-fill" });
    fill.style.width = `${pct}%`;
    bar.append(fill);
    overlay.append(bar);
    if (s.totalBytes && s.bytesCopied != null) {
      overlay.append(el("div", { class: "import-bytes" },
        `${formatBytes(s.bytesCopied)} / ${formatBytes(s.totalBytes)}`));
    }
  } else if (s.phase === "done") {
    overlay.append(el("div", { class: "import-row done" },
      el("strong", {}, `Imported ${s.copied} of ${s.total}`),
    ));
    const dismiss = el("button", { class: "import-dismiss", type: "button" }, "Dismiss");
    dismiss.addEventListener("click", () => { importStatus = null; renderMain(); });
    overlay.append(dismiss);
  } else if (s.phase === "error") {
    overlay.append(el("div", { class: "import-row error" },
      el("strong", {}, `Import failed after ${s.copied ?? 0} of ${s.total}`),
      el("span", { class: "import-err-msg" }, s.error ?? ""),
    ));
    const dismiss = el("button", { class: "import-dismiss", type: "button" }, "Dismiss");
    dismiss.addEventListener("click", () => { importStatus = null; renderMain(); });
    overlay.append(dismiss);
  }
  return overlay;
}

function visibleMedia(): MediaItem[] {
  return media.filter((m) => m.kind === filter);
}

function buildMediaTable(): HTMLElement {
  const wrap = el("div", { class: "media-table-wrap" });

  const grid = el("div", { class: "media-grid" });
  grid.addEventListener("click", (e) => {
    // Clicking the empty grid area clears selection.
    if (e.target === grid) clearSelection();
  });

  thumbObserver?.disconnect();
  thumbObserver = newThumbObserver(grid);
  const visible = visibleMedia();
  visible.forEach((item, i) => grid.append(buildMediaCell(item, i)));
  wrap.append(grid);

  // Optional progress overlay (only when an import is in flight or
  // just finished and the user hasn't dismissed it).
  const overlay = buildImportOverlay();
  if (overlay) wrap.append(overlay);

  // Footer
  const footer = el("div", { class: "media-footer" });
  const summaryEl = el("span", { class: "footer-summary" }, "");
  footer.append(summaryEl);
  const importBtn = el("button", { class: "import-btn", type: "button", disabled: "" },
    "Import") as HTMLButtonElement;
  importBtn.addEventListener("click", () => void startImport());
  footer.append(importBtn);
  wrap.append(footer);

  // Initial footer paint after the elements are in the DOM.
  queueMicrotask(paintFooter);

  return wrap;
}

function buildMediaCell(item: MediaItem, index: number): HTMLElement {
  const cell = el("div", { class: "media-cell" });
  cell.dataset.path = item.path;
  cell.dataset.index = String(index);
  if (selected.has(item.path)) cell.setAttribute("data-selected", "true");
  if (item.kind === "video") cell.setAttribute("data-video", "true");

  // Thumbnail slot — kept blank until IntersectionObserver fires.
  const thumbWrap = el("div", { class: "thumb" });
  thumbWrap.append(iconSvg(item.kind === "video" ? "video" : "image", 28));
  cell.append(thumbWrap);

  // Check overlay (rendered in CSS via data-selected="true").

  // Caption: filename + size.
  const cap = el("div", { class: "cell-caption" });
  cap.append(el("div", { class: "cell-name", title: item.name }, item.name));
  cap.append(el("div", { class: "cell-meta" }, formatBytes(item.size)));
  cell.append(cap);

  cell.addEventListener("click", (e) => onCellClick(e, index));
  thumbObserver?.observe(cell);
  return cell;
}

function onCellClick(e: MouseEvent, index: number) {
  e.stopPropagation();
  const visible = visibleMedia();
  const item = visible[index];
  if (!item) return;

  if (e.shiftKey && anchorIndex >= 0) {
    const [a, b] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
    for (let i = a; i <= b; i++) selected.add(visible[i].path);
  } else if (e.ctrlKey || e.metaKey) {
    if (selected.has(item.path)) selected.delete(item.path);
    else selected.add(item.path);
    anchorIndex = index;
  } else {
    selected.clear();
    selected.add(item.path);
    anchorIndex = index;
  }
  refreshSelectionView();
}

// --- Lazy thumbnail loading ------------------------------------------

const thumbCache = new Map<string, string>(); // path -> data URL
const thumbFailed = new Set<string>(); // paths whose decode failed
let thumbObserver: IntersectionObserver | null = null;

function newThumbObserver(root: HTMLElement): IntersectionObserver {
  return new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const cell = entry.target as HTMLElement;
      const p = cell.dataset.path;
      if (!p) continue;
      thumbObserver?.unobserve(cell);
      void loadThumb(p, cell);
    }
  }, { root, rootMargin: "200px" });
}

async function loadThumb(path: string, cell: HTMLElement) {
  if (thumbFailed.has(path)) return;
  const cached = thumbCache.get(path);
  if (cached) { paintThumb(cell, cached); return; }
  try {
    const url = await invoke<string>("thumb_for", { path });
    thumbCache.set(path, url);
    paintThumb(cell, url);
  } catch (e) {
    // HEIC without libheif-dev, broken file, etc — leave the icon in
    // place and mark so we don't retry on every scroll.
    thumbFailed.add(path);
    console.warn("thumb_for failed for", path, e);
  }
}

function paintThumb(cell: HTMLElement, url: string) {
  const slot = cell.querySelector(".thumb");
  if (!slot) return;
  const img = el("img", { src: url, alt: "", loading: "lazy" });
  slot.replaceChildren(img);
}

// ---- Device flow ---------------------------------------------------

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  device = { kind: "none" };
  media = [];
  renderAux();
  renderMain();

  try {
    // Always re-check env first — user may have just apt-installed something.
    try {
      env = await invoke<EnvCheck>("check_environment");
    } catch (e) {
      console.error("check_environment failed:", e);
    }
    if (!env || !envOk(env)) return;

    try {
      device = await invoke<DeviceState>("probe_device");
    } catch (e) {
      console.error("probe_device failed:", e);
    }
    if (device.kind === "ready") {
      try {
        await invoke("mount_device", { udid: device.device.udid });
        // list_media now streams via media-batch events; the await just
        // resolves once the walk is done. Frontend state is driven by
        // those events (see boot()) — `media` may already have items
        // by the time this returns.
        media = [];
        listing = true;
        renderAux();
        renderMain();
        await invoke("list_media");
      } catch (e: any) {
        // Mount failures here are post-pair — usually a race where the
        // user accepted Trust but lockdownd hasn't propagated the new
        // pair record yet. Asking them to refresh again almost always
        // works.
        device = {
          kind: "needs-trust",
          device: device.device,
          hint: `Couldn't mount the iPhone (${String(e)}). Try Refresh again in a second.`,
        };
        console.warn("mount/list failed:", e);
      }
    }
  } finally {
    refreshing = false;
    renderAux();
    renderMain();
  }
}

// ---- Boot ----------------------------------------------------------

async function boot() {
  const chrome = mountChrome({
    productName: "Photo Importer",
    actions: {},
    showStatusLine: false,
    showAuxPane: true,
    updater: true,
  });
  viewportEl = chrome.viewport;
  auxEl = chrome.aux!;
  auxEl.classList.add("photos-aux");

  const topbar = buildMainTopbar();
  mainContentEl = el("div", { class: "main-content" });
  viewportEl.replaceChildren(topbar, mainContentEl);

  // Load persisted settings (last destination folder).
  try {
    const s = await invoke<{ lastDestination?: string }>("load_settings");
    lastDestination = s.lastDestination ?? null;
  } catch (e) { console.warn("load_settings failed:", e); }

  // Import progress.
  await listen<ImportStatus>("import-status", (e) => {
    importStatus = e.payload;
    // Tiny throttling: copying events arrive fast, just redraw the
    // overlay's bar via the existing render path.
    renderMain();
    if (importStatus.phase === "done") {
      // Auto-dismiss after a few seconds so the grid is usable again.
      setTimeout(() => {
        if (importStatus?.phase === "done") {
          importStatus = null;
          renderMain();
        }
      }, 2500);
    }
  });

  // Streamed listing — append each batch as it arrives. Re-render
  // is debounced so 30k items in 600 batches don't repaint the table
  // 600 times.
  await listen<MediaItem[]>("media-batch", (e) => {
    if (!Array.isArray(e.payload)) return;
    media.push(...e.payload);
    scheduleRender();
  });
  await listen<{ total: number }>("media-done", (_e) => {
    listing = false;
    // Final sort: backend doesn't sort across batches, so the in-memory
    // list ends up in walk-order. Reorder newest-first now that we have
    // everything.
    media.sort((a, b) => b.modified_ms - a.modified_ms);
    renderAux();
    renderMain();
  });

  renderAux();
  renderMain();
  await refresh();
}

function scheduleRender() {
  if (pendingRender) return;
  pendingRender = requestAnimationFrame(() => {
    pendingRender = 0;
    renderAux();
    renderMain();
  });
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
