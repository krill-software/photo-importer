# Photos Import

> Plug in your iPhone, pick photos and videos to keep, batch-save them
> to a Linux folder.

Part of the [krill](https://krill.software) umbrella of small, calm,
single-purpose Linux apps. See [SPEC.md](SPEC.md) for the full design.

## Runtime dependencies

| Package          | Why                                       | Install                                  |
|------------------|-------------------------------------------|------------------------------------------|
| libimobiledevice | Talk to iPhone over USB                   | `sudo apt install libimobiledevice-utils`|
| ifuse            | Mount the iPhone DCIM as a filesystem     | `sudo apt install ifuse`                 |
| libheif          | Decode HEIC for thumbnails (M2+)          | `sudo apt install libheif1`              |

## Safety

The app is **strictly read-only against the iPhone** — it never
deletes, modifies, moves, or renames anything on the phone. Imports
copy; originals stay put.

## Status

Pre-v1. Currently at M1: device detection + media listing.

## License

MIT
