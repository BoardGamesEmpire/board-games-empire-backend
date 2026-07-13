# storage

This library was generated with [Nx](https://nx.dev).

## Running unit tests

Run `nx test storage` to execute the unit tests via [Jest](https://jestjs.io).

## LocalDiskDriver: runtime unmount detection

`LocalDiskDriver` stores objects under a filesystem root (`MEDIA_LOCAL_DISK_ROOT`)
that is expected to be an operator-provisioned volume (a mount point). A **clean
`umount` leaves the mountpoint directory in place** — now empty and backed by the
underlying disk. A naive `stat(root)` still succeeds, so without extra checks
`ping()` would report healthy and `put()`'s recursive `mkdir` would happily
recreate the object subtree on the underlying disk. Those bytes vanish on
remount: silent data loss.

To catch this, the driver can compare the mount's identity against a baseline
captured at boot. The strategy is chosen with `MEDIA_LOCAL_DISK_MOUNT_CHECK`.

### Modes (`MEDIA_LOCAL_DISK_MOUNT_CHECK`)

| Mode | What it does | Operator action | Best for |
| --- | --- | --- | --- |
| `auto` *(default)* | Enables `st_dev` **only if** the root is a distinct mount (its device id differs from its parent directory's). Otherwise it's a no-op. | None | Dedicated block volumes / K8s PVs, and local dev |
| `st_dev` | Always records `statSync(root).dev` at boot and compares it on every probe / before every write. | None | Dedicated volumes where you want the check forced on |
| `sentinel` | Requires an operator-provisioned marker file under the root; its absence means the volume isn't mounted. | Create the marker (below) | NFS, overlayfs, bind mounts — anywhere `st_dev` is unreliable |
| `off` | No unmount detection (original behavior; zero overhead on writes). | None | Opt-out |

On a detected unmount, `ping()` and `put()` raise `StorageUnavailableError`
(`retryable: true`) — `put()` refuses **before** writing, so nothing lands on a
phantom directory. Reads inherit the check via their existing not-found path.

In any mode other than `off`, `put()` runs one extra `stat` on the root (two in
`sentinel` mode — root plus marker) before writing. This is negligible on local
disks; on NFS each is a network round-trip, so `off` remains available where that
per-write cost isn't wanted.

### `st_dev` caveats — when to prefer `sentinel`

`st_dev` (the filesystem device id) is a reliable signal for a dedicated block
volume, but **not** everywhere:

- **NFS** assigns synthetic/anonymous device numbers that can *change across a
  legitimate remount*. After a normal drop/reconnect the id may differ from the
  boot baseline, producing a false "unavailable" that only clears on process
  restart (the restart re-captures the baseline). Prefer `sentinel`.
- **overlayfs / bind mounts** (common with host-directory Docker mounts) may
  share a device id with the container root filesystem, or mask it
  unpredictably. `auto` degrades to a no-op in the share case (safe, but no
  protection); use `sentinel` if you need a guarantee.

`auto` enables `st_dev` for **any** distinct mount — it cannot tell NFS from a
block volume, so it *will* turn on the device check on an NFS root even though the
id can shift across a legitimate remount. On NFS/overlay/bind, set `sentinel`
explicitly rather than relying on `auto`. When the root is **not** a distinct
mount, `auto` disables the check and logs a `warn` — so a dedicated volume that
simply wasn't mounted at boot is visible in the logs rather than silently
unprotected for the process lifetime.

### Provisioning the sentinel (`sentinel` mode)

The driver **never creates** the sentinel: auto-creating it would let a restarted
process re-mark an *empty* mountpoint on the underlying disk and reinstate the
exact data-loss bug. Create it yourself, once, after the volume is mounted:

```sh
touch "$MEDIA_LOCAL_DISK_ROOT/.bge-storage-sentinel"   # filename: MEDIA_LOCAL_DISK_SENTINEL_FILE
```

If it's missing at boot, the driver fails fast with a `StorageMisconfiguredError`
that prints the exact command to run. In Kubernetes, run the `touch` from an
**init container** (or a one-shot Job) against the mounted volume before the main
container starts — it naturally runs only when the volume is actually present.

### Hung mounts, probe timeout, and the fatal watchdog

A hard-mounted NFS server that becomes unreachable makes `stat` **block
indefinitely** rather than error. Two mechanisms bound this:

- `MEDIA_LOCAL_DISK_PROBE_TIMEOUT_MS` (default `5000`) caps each probe so
  readiness reports down instead of hanging.
- `MEDIA_LOCAL_DISK_PROBE_TIMEOUT_FATAL_THRESHOLD` (default `3`, `0` disables):
  after this many *consecutive* probe timeouts the process self-exits (hard exit,
  not a graceful shutdown) so the orchestrator restarts it.

> **Why self-exit?** A blocked `stat` keeps occupying a **libuv threadpool** slot
> even after the JS-level timeout fires — the timeout unblocks the caller, not the
> kernel syscall. The default threadpool has only **4** slots and is shared by all
> async `fs`, `dns.lookup`, and some `crypto`; once exhausted by hung probes,
> *every* async filesystem and DNS operation in the process stalls (including DB
> and Redis hostname resolution). This does **not** block the event loop, so an
> HTTP liveness probe still returns 200 — the process looks alive while being
> functionally dead. Restarting is the only reliable recovery, and readiness
> alone won't restart, so the watchdog does.
>
> Operators expecting hung-mount exposure (e.g. NFS) may raise
> `UV_THREADPOOL_SIZE` (e.g. `16`–`32`) as defense-in-depth — but note this only
> *delays* exhaustion under a persistent hang; it does not prevent it. Managing
> that env var is left to the operator.
