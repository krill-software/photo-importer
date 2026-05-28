# Photo Importer

> Plug in your iPhone, pick photos and videos to keep, batch-save them
> to a Linux folder.

Part of the [krill](https://krill.software) umbrella of small, calm,
single-purpose Linux apps. See [SPEC.md](SPEC.md) for the full design.

## Runtime dependencies

| Package            | Why                                          | Install                                   |
|--------------------|----------------------------------------------|-------------------------------------------|
| libimobiledevice   | Talk to iPhone over USB                      | `sudo apt install libimobiledevice-utils` |
| ifuse              | Mount the iPhone DCIM as a filesystem        | `sudo apt install ifuse`                  |
| fuse               | Userspace filesystem support                 | `sudo apt install fuse`                   |
| usbmuxd            | USB↔iPhone bridge daemon                     | `sudo apt install usbmuxd`                |
| libheif-examples   | HEIC thumbnails (heif-thumbnailer binary)    | `sudo apt install libheif-examples`       |

The app's setup checklist on first launch surfaces the four
iPhone-related deps with click-to-copy install commands. HEIC support
is optional — without `libheif-examples`, HEIC files still show up in
the grid but with a generic icon instead of a real thumbnail.

We shell out to `heif-thumbnailer` rather than linking libheif via a
Rust binding, on purpose: libheif-sys's ABI version pin (currently
≥1.21) breaks on distros that ship older libheif (Ubuntu 24.04 has
1.17). Shelling out works against whatever libheif version the host
provides.

## Safety

The app is **strictly read-only against the iPhone** — it never
deletes, modifies, moves, or renames anything on the phone. Imports
copy; originals stay put.

## Status

Pre-v1. Currently at M3: thumbnail grid with multi-select + batch import.

## License

MIT
