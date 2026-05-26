import "@krill-software/desktop-ui/styles";
import "./styles.css";
import { mountChrome, showBootError, checkForUpdates } from "@krill-software/desktop-ui";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

  // Refresh row — at the top so the most-used action is closest to
  // the hamburger.
  const refreshRow = el("button", {
    class: "aux-nav refresh-row",
    type: "button",
    title: "Refresh device",
  });
  if (refreshing) refreshRow.setAttribute("data-refreshing", "true");
  const refreshIcon = el("div", { class: "aux-nav-icon" });
  refreshIcon.append(iconSvg("refresh-cw", 16));
  refreshRow.append(refreshIcon);
  const refreshText = el("div", { class: "aux-nav-text" });
  refreshText.append(el("div", { class: "aux-nav-name" },
    refreshing ? "Syncing…" : "Refresh"));
  refreshText.append(el("div", { class: "aux-nav-sub" },
    refreshing ? "talking to the iPhone" : "re-detect the iPhone"));
  refreshRow.append(refreshText);
  refreshRow.addEventListener("click", () => {
    if (!refreshing) void refresh();
  });
  auxEl.append(refreshRow);

  // Device card
  const deviceCard = el("div", { class: "device-card" });
  const visual = el("div", { class: "device-visual" });
  visual.append(iconSvg("smartphone", 24));
  deviceCard.append(visual);
  const text = el("div", { class: "device-text" });
  if (env && !envOk(env)) {
    text.append(el("div", { class: "device-name muted" }, "Setup needed"));
    text.append(el("div", { class: "device-sub" }, "Install missing tools first"));
  } else {
    switch (device.kind) {
      case "none":
        text.append(el("div", { class: "device-name muted" }, "No iPhone"));
        text.append(el("div", { class: "device-sub" }, "Plug one in via USB"));
        break;
      case "needs-trust":
        text.append(el("div", { class: "device-name" }, device.device.name));
        text.append(el("div", { class: "device-sub" }, "Tap Trust on the iPhone"));
        break;
      case "ready":
        text.append(el("div", { class: "device-name" }, device.device.name));
        text.append(el("div", { class: "device-sub" }, "connected"));
        break;
    }
  }
  deviceCard.append(text);
  auxEl.append(deviceCard);

  // Counts (only meaningful when ready)
  if (device.kind === "ready" && media.length > 0) {
    const counts = el("div", { class: "device-counts" });
    const total = media.length;
    const photos = media.filter((m) => m.kind === "image").length;
    const videos = media.filter((m) => m.kind === "video").length;
    counts.append(el("div", { class: "counts-row" },
      el("span", {}, "All"),
      el("span", { class: "counts-num" }, String(total)),
    ));
    counts.append(el("div", { class: "counts-row" },
      el("span", {}, "Photos"),
      el("span", { class: "counts-num" }, String(photos)),
    ));
    counts.append(el("div", { class: "counts-row" },
      el("span", {}, "Videos"),
      el("span", { class: "counts-num" }, String(videos)),
    ));
    auxEl.append(counts);
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

function buildMediaTable(): HTMLElement {
  const wrap = el("div", { class: "media-table-wrap" });
  const head = el("div", { class: "media-table-head" });
  head.append(el("span", { class: "col-name" }, "Name"));
  head.append(el("span", { class: "col-kind" }, "Kind"));
  head.append(el("span", { class: "col-size" }, "Size"));
  head.append(el("span", { class: "col-date" }, "Captured"));
  wrap.append(head);

  const list = el("div", { class: "media-table" });
  for (const item of media) {
    const row = el("div", { class: "media-row" });
    const nameCell = el("span", { class: "col-name", title: item.path });
    nameCell.append(iconSvg(item.kind === "video" ? "video" : "image", 14));
    nameCell.append(el("span", {}, item.name));
    row.append(nameCell);
    row.append(el("span", { class: "col-kind" }, item.ext.toUpperCase()));
    row.append(el("span", { class: "col-size mono" }, formatBytes(item.size)));
    row.append(el("span", { class: "col-date mono" },
      new Date(item.modified_ms).toLocaleString()));
    list.append(row);
  }
  wrap.append(list);

  // Footer with count + (stubbed) import button
  const footer = el("div", { class: "media-footer" });
  const totalBytes = media.reduce((a, m) => a + m.size, 0);
  const summary = listing
    ? `Listing… ${media.length} so far · ${formatBytes(totalBytes)}`
    : `${media.length} item${media.length === 1 ? "" : "s"} on device · ${formatBytes(totalBytes)}`;
  const summaryEl = el("span", { class: "footer-summary" }, summary);
  if (listing) summaryEl.setAttribute("data-listing", "true");
  footer.append(summaryEl);
  const importBtn = el("button", { class: "import-btn", type: "button", disabled: "" },
    "Import (coming in M3)") as HTMLButtonElement;
  footer.append(importBtn);
  wrap.append(footer);

  return wrap;
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
