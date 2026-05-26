import "@krill-software/desktop-ui/styles";
import "./styles.css";
import { mountChrome, showBootError, checkForUpdates } from "@krill-software/desktop-ui";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icons as lucideIcons, createElement as createLucide } from "lucide";

// ---- Types (mirror Rust) -------------------------------------------

interface Device { udid: string; name: string }
type DeviceState =
  | { kind: "none" }
  | { kind: "tools-missing"; which: string }
  | { kind: "needs-trust"; device: Device }
  | { kind: "ready"; device: Device };

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
    { label: "Check for updates…", action: () => void checkForUpdates("Photos Import") },
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

  // Device card
  const deviceCard = el("div", { class: "device-card" });
  const visual = el("div", { class: "device-visual" });
  visual.append(iconSvg("smartphone", 24));
  deviceCard.append(visual);
  const text = el("div", { class: "device-text" });
  switch (device.kind) {
    case "none":
      text.append(el("div", { class: "device-name muted" }, "No iPhone"));
      text.append(el("div", { class: "device-sub" }, "Plug one in via USB"));
      break;
    case "tools-missing":
      text.append(el("div", { class: "device-name muted" }, "Missing tool"));
      text.append(el("div", { class: "device-sub" }, device.which + " not installed"));
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
  deviceCard.append(text);
  auxEl.append(deviceCard);

  // Refresh row
  const refreshRow = el("button", { class: "aux-nav", type: "button", title: "Refresh device" });
  const refreshIcon = el("div", { class: "aux-nav-icon" });
  refreshIcon.append(iconSvg("refresh-cw", 16));
  refreshRow.append(refreshIcon);
  const refreshText = el("div", { class: "aux-nav-text" });
  refreshText.append(el("div", { class: "aux-nav-name" }, "Refresh"));
  refreshText.append(el("div", { class: "aux-nav-sub" }, "re-detect the iPhone"));
  refreshRow.append(refreshText);
  refreshRow.addEventListener("click", () => void refresh());
  auxEl.append(refreshRow);

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

  // Empty / error states based on device kind
  switch (device.kind) {
    case "tools-missing":
      root.append(buildBanner("error",
        `${device.which} not found.`,
        "Install with apt:",
        el("pre", { class: "banner-pre" }, "sudo apt install libimobiledevice-utils ifuse libheif1"),
      ));
      break;
    case "none":
      root.append(buildEmptyState(
        "Plug in your iPhone",
        "Connect via USB cable. The first time, your iPhone will ask you to trust this computer.",
      ));
      break;
    case "needs-trust":
      root.append(buildBanner("info",
        `Tap "Trust This Computer" on your iPhone, then click Refresh.`,
      ));
      break;
    case "ready":
      if (media.length === 0) {
        root.append(buildEmptyState(
          "No media found",
          "Your iPhone is connected but /DCIM/ is empty (or still listing). Try Refresh.",
        ));
      } else {
        root.append(buildMediaTable());
      }
      break;
  }

  mainContentEl.replaceChildren(root);
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
  footer.append(el("span", { class: "footer-summary" },
    `${media.length} item${media.length === 1 ? "" : "s"} on device · ${formatBytes(media.reduce((a, m) => a + m.size, 0))}`));
  const importBtn = el("button", { class: "import-btn", type: "button", disabled: "" },
    "Import (coming in M3)") as HTMLButtonElement;
  footer.append(importBtn);
  wrap.append(footer);

  return wrap;
}

// ---- Device flow ---------------------------------------------------

async function refresh() {
  device = { kind: "none" };
  media = [];
  renderAux();
  renderMain();
  try {
    device = await invoke<DeviceState>("probe_device");
  } catch (e) {
    console.error("probe_device failed:", e);
  }
  if (device.kind === "ready") {
    try {
      await invoke("mount_device", { udid: device.device.udid });
      media = await invoke<MediaItem[]>("list_media");
    } catch (e: any) {
      // Mount failures usually mean Trust hasn't been granted yet.
      device = { kind: "needs-trust", device: device.device };
      console.warn("mount/list failed:", e);
    }
  }
  renderAux();
  renderMain();
}

// ---- Boot ----------------------------------------------------------

async function boot() {
  const chrome = mountChrome({
    productName: "Photos Import",
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

  renderAux();
  renderMain();
  await refresh();
}

boot().catch((e) => {
  console.error("boot failed:", e);
  showBootError(e);
});
