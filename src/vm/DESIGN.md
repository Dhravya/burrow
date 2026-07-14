# VM module — design proposal (NOT IMPLEMENTED)

> **Status: design only.** Nothing in this document is implemented. There is no
> `src/vm/index.ts`, no emulator, no `linux` tab in the UI, and v86 is not a
> dependency. This file is the proposed type contract for a future in-browser
> Linux VM feature, kept as a design doc so the interface thinking isn't lost.
> If/when the feature is built, these types would move back into `.ts` files.

## Summary

The idea: embed [v86](https://github.com/copy/v86) (an x86 PC emulator in
WASM) to boot a real Linux guest inside the page, alongside the existing
JS-based toolchain. The VM world is deliberately separate: v86 emulates a full
PC with its own kernel and disk, and does **not** share the VFS. Any file
exchange is an explicit copy (9p, serial paste, or future helpers) — never
implicit sharing.

Proposed file layout (none of these exist):

- `src/vm/index.ts` — module facade (`initVm` / `mountLinuxTab` / `getVm`)
- `src/vm/emulator.ts` — v86 lifecycle (boot/pause/resume/save/restore)
- `src/vm/disk.ts` — boot-profile catalog + IndexedDB state persistence
- `src/vm/netbridge.ts` — guest TCP port probing + in-page HTTP dial-in
- `src/vm/console.ts` — serial ⇄ terminal bridge
- `src/vm/assets/` — kernel/BIOS/rootfs binaries served under `/vm-assets`

Note on v86 versioning: v86's `restore_state` is only valid across identical
emulator versions and construction options, so the implementation must pin an
exact v86 version (e.g. `bun add --exact v86@<version>`) and stamp it into
every persisted state record. v86 is intentionally **not** installed today.

## Proposed type contract

```ts
// Exact v86 npm version the module would be built against; stamped into
// every persisted state record (see versioning note above).
export const V86_VERSION = "0.5.424";

/** Same-origin URL prefix for all VM binary assets (route reported to coordinator). */
export const VM_ASSETS_PREFIX = "/vm-assets";

/**
 * Optional same-origin CORS proxy for guest outbound HTTP (Phase 2, apk).
 * Only used if the coordinator applies the optional /vm-proxy route.
 */
export const VM_PROXY_PREFIX = "/vm-proxy";

/** IndexedDB database / object store for persisted machine state. */
export const VM_STATE_DB = "burrow-vm";
export const VM_STATE_STORE = "states";

/** Guest IP handed out by v86's built-in DHCP on the `fetch` network backend. */
export const VM_GUEST_IP = "192.168.86.100";

/** Bottom-pane tab id used by mountLinuxTab / the UI tab controller. */
export const VM_TAB_ID = "linux";

// ============================================================================
// Boot profiles (disk.ts owns the concrete catalog)
// ============================================================================

/** Identifies one bootable image configuration. Part of the state-record key. */
export type VmImageId = "buildroot68" | "alpine321-i386";

export interface VmAssetRef {
  /** File name under src/vm/assets/, e.g. "buildroot-bzimage68.bin". */
  name: string;
  /** Absolute same-origin URL, i.e. `${VM_ASSETS_PREFIX}/${name}`. */
  url: string;
  /** Expected byte size (drives the aggregate download progress bar). */
  bytes: number;
}

/**
 * Everything needed to construct V86 deterministically. Two boots with the
 * same profile + same V86_VERSION are state-restore compatible; ANY field
 * change requires a new `imageId` (or a bump of `revision`) so stale
 * IndexedDB states are discarded instead of corrupting a restore.
 */
export interface VmBootProfile {
  imageId: VmImageId;
  /** Bump when any option below changes without a new imageId. Part of the state key. */
  revision: number;
  /** Power of 2. 64 MiB for buildroot, 256–512 MiB for Alpine+node. */
  memoryBytes: number;
  /** 2 MiB is plenty for a serial-only machine. */
  vgaMemoryBytes: number;
  /** Kernel command line, e.g. "tsc=reliable mitigations=off random.trust_cpu=on". */
  cmdline: string;
  wasm: VmAssetRef;
  bios: VmAssetRef;
  vgaBios: VmAssetRef;
  /** Direct kernel boot (Phase 1: buildroot bzimage). */
  bzimage?: VmAssetRef;
  /** 9p lazy rootfs (Phase 2: Alpine). */
  filesystem?: { basefsUrl: string; baseUrl: string };
  /** Pre-baked boot-skipping state (Phase 2), served as .zst for auto-decompress. */
  initialStateUrl?: string;
  /** Guest network config; `relayUrl` is always "fetch" (no external relay). */
  net: { relayUrl: "fetch"; corsProxy?: string };
}

// ============================================================================
// Emulator lifecycle (emulator.ts)
// ============================================================================

export type VmPhase =
  | "idle" // constructed, nothing downloaded — mountLinuxTab shows the boot splash
  | "fetching" // downloading /vm-assets/* (first boot only; HTTP cache after)
  | "restoring" // applying a saved state instead of cold boot
  | "booting" // v86 started, waiting for the serial getty
  | "running"
  | "paused" // CPU stopped via pause(); state intact, resume() continues
  | "saving" // save_state() in flight (brief; CPU is stopped during it)
  | "halted" // destroyed or guest powered off; boot() starts over
  | "error";

export interface VmStatus {
  phase: VmPhase;
  /** Human-readable detail for the tab UI (error message, boot step, …). */
  detail?: string;
}

export interface VmDownloadProgress {
  /** Asset file name currently downloading. */
  file: string;
  loadedBytes: number;
  totalBytes: number;
  /** 0..1 across ALL assets of the boot profile (drive one bar from this). */
  overallFraction: number;
}

export interface VmBootOptions {
  /**
   * Try to restore the persisted IndexedDB state for this profile before
   * cold-booting. Default true. Restore failure (version/image mismatch,
   * corrupt record) silently falls back to cold boot and clears the record.
   */
  tryRestore?: boolean;
}

/**
 * One virtual machine. Exactly one instance exists per page (singleton owned
 * by index.ts) because v86 runs on the main thread and each instance costs
 * `memoryBytes` of wasm memory.
 */
export interface VmEmulator {
  readonly profile: VmBootProfile;

  /** Idempotent while booting/running. Downloads assets on first call. */
  boot(options?: VmBootOptions): Promise<void>;

  /** Stop the CPU (v86 stop()). No-op unless running. UI calls this when the tab is hidden long-term. */
  pause(): void;

  /** Continue after pause(). No-op unless paused. */
  resume(): void;

  status(): VmStatus;
  onStatus(cb: (status: VmStatus) => void): () => void;
  onDownloadProgress(cb: (progress: VmDownloadProgress) => void): () => void;

  /**
   * Serialize full machine state (RAM + devices + dirty disk). Raw,
   * uncompressed bytes — disk.ts compresses before IndexedDB. The CPU is
   * briefly stopped while saving.
   */
  saveState(): Promise<Uint8Array>;

  /** Replace machine state. Caller guarantees same profile + V86_VERSION. */
  restoreState(state: Uint8Array): Promise<void>;

  /** Tear down v86 + release wasm memory. status → "halted". boot() re-creates. */
  destroy(): Promise<void>;

  /** Byte-level serial port 0 (ttyS0) — console.ts builds the terminal bridge on this. */
  readonly serial: VmSerial;

  /**
   * The raw V86 instance (typed unknown to keep v86 types out of the
   * contract). ONLY netbridge.ts/console.ts/disk.ts may cast it.
   */
  readonly raw: unknown;
}

/** Byte-level serial transport. UTF-8 is the guest's problem, not this layer's. */
export interface VmSerial {
  /** Strings are sent as UTF-8 bytes. Safe to call before boot (buffered, flushed on "running"). */
  send(data: string | Uint8Array): void;
  /**
   * Subscribe to guest output. New subscribers immediately receive the ring
   * buffer replay (last VM_SERIAL_SCROLLBACK bytes) as one chunk, so a
   * terminal attached late still shows the boot log. Returns unsubscribe.
   */
  onData(cb: (chunk: Uint8Array) => void): () => void;
}

/** Ring buffer size for serial replay (bytes). */
export const VM_SERIAL_SCROLLBACK = 256 * 1024;

// ============================================================================
// Console bridge (console.ts)
// ============================================================================

/**
 * What console.ts needs from a terminal widget — deliberately minimal so it
 * works with a DOM terminal widget without importing it here. The linux tab
 * constructs its own terminal instance; it does NOT reuse the shell module's
 * terminal (different world, different prompt).
 */
export interface VmTerminalLike {
  /** Write raw output (ANSI passes through; CRLF handling is the widget's). */
  write(data: string): void;
  /** Called by the widget for every user keystroke / paste. */
  onData(cb: (data: string) => void): void;
  focus(): void;
}

export interface VmConsole {
  /**
   * Wire terminal ⇄ serial: guest bytes → term.write (decoded latin1-safe),
   * term.onData → serial.send. Replays scrollback on attach. Returns detach.
   * At most one terminal attached at a time (attach replaces).
   */
  attach(term: VmTerminalLike): () => void;

  /** Convenience for automation: send a line + "\n" to the guest shell. */
  exec(line: string): void;

  /** Drop the scrollback ring buffer (e.g. user pressed "clear"). */
  clearScrollback(): void;
}

// ============================================================================
// State + asset persistence (disk.ts)
// ============================================================================

/** Key = `${imageId}#${revision}@${v86Version}`. One record per key, newest wins. */
export interface VmStateRecord {
  key: string;
  imageId: VmImageId;
  revision: number;
  v86Version: string;
  savedAtMs: number;
  /** "gzip" via CompressionStream, or "none". */
  compression: "gzip" | "none";
  /** Compressed byte size (for the settings/storage UI). */
  storedBytes: number;
  payload: Blob;
}

export interface VmStateStore {
  /** Compress + upsert the record for this profile. */
  save(profile: VmBootProfile, state: Uint8Array): Promise<void>;
  /**
   * Load + decompress the state for this profile. Returns null when absent
   * OR when the stored v86Version/revision doesn't match (mismatch records
   * are deleted — a stale restore corrupts the machine).
   */
  load(profile: VmBootProfile): Promise<Uint8Array | null>;
  /** Drop the record for this profile (also used as mismatch cleanup). */
  clear(profile: VmBootProfile): Promise<void>;
  /** All records, for a future storage-management UI. */
  list(): Promise<Omit<VmStateRecord, "payload">[]>;
}

// ============================================================================
// Guest-port bridge (netbridge.ts)
// ============================================================================
// v86's `fetch` network backend runs a full TCP stack in page JS. Page code
// dials INTO guest listeners via network_adapter.tcp_probe/connect — no
// external relay. This is the surface a future /proxy/:port/* port-
// forwarding layer would consume.
// ============================================================================

export interface GuestPortInfo {
  port: number;
  /** v1 only ever reports "tcp" (v86's JS dial-in is TCP-only). */
  proto: string;
}

/**
 * A raw duplex byte stream to a TCP listener inside the guest
 * (wraps v86's TCPConnection from the fetch network adapter).
 */
export interface GuestConnection {
  readonly port: number;
  /** Resolved connect handshake. write() before this rejects/queues per impl. */
  readonly opened: Promise<void>;
  write(data: Uint8Array): void;
  onData(cb: (chunk: Uint8Array) => void): () => void;
  onClose(cb: () => void): () => void;
  close(): void;
}

export interface GuestPortHandler {
  /** Port transitioned closed → open (guest server started listening). */
  onOpen(info: GuestPortInfo): void;
  /** Port transitioned open → closed (server stopped / VM paused or halted). */
  onClose?(info: GuestPortInfo): void;
}

/**
 * Shape for the future port-forwarding layer. `listPorts`, `onPortOpen` and
 * `fetchThroughGuest` are the contract a /proxy/:port/* router would consume.
 *
 * Discovery model: v86 cannot enumerate guest sockets, so the bridge probes a
 * watch set (registered ports + VM_DEFAULT_WATCH_PORTS) with tcp_probe on an
 * interval while the VM is running. "Open" therefore means "answered a SYN
 * probe within the last sweep".
 */
export interface GuestPortBridge {
  /** Ports currently believed open (last successful probe sweep). */
  listPorts(): GuestPortInfo[];

  /** Fires on every closed → open transition. Returns unsubscribe. */
  onPortOpen(cb: (info: GuestPortInfo) => void): () => void;

  /** Fires on every open → closed transition. Returns unsubscribe. */
  onPortClose(cb: (info: GuestPortInfo) => void): () => void;

  /**
   * Speak HTTP/1.1 to a guest server over a fresh in-page TCP connection and
   * return a standard Response. This is what /proxy/:port/* forwards into.
   *
   * Contract (holds even while the impl is a stub):
   *  - MUST NOT hang: reject within VM_GUEST_HTTP_TIMEOUT_MS.
   *  - VM not running          → reject VmError("vm-not-running").
   *  - Connection refused      → reject VmError("port-closed").
   *  - Stubbed implementation  → reject VmError("not-implemented").
   *  - Request bodies are read fully (arrayBuffer) — no streaming in v1.
   *  - Response: status/headers parsed from the HTTP/1.1 head; body from
   *    Content-Length or chunked encoding; "Connection: close" is always sent.
   */
  fetchThroughGuest(port: number, request: Request): Promise<Response>;

  /**
   * Add `port` to the probe watch set and receive open/close callbacks.
   * Multiple registrations per port are fine (all handlers fire).
   * Returns unregister (removes handler; port leaves the watch set when no
   * handlers remain and it isn't a default watch port).
   */
  registerGuestPort(port: number, handler: GuestPortHandler): () => void;

  /** Open a raw TCP connection to a guest port (basis of fetchThroughGuest). */
  connect(port: number): GuestConnection;
}

/** Common dev-server ports probed even without registration. */
export const VM_DEFAULT_WATCH_PORTS: readonly number[] = [80, 3000, 8000, 8080];

/** Probe sweep interval while running (ms). Probing is cheap: one SYN in page JS. */
export const VM_PORT_PROBE_INTERVAL_MS = 2000;

/** Upper bound for fetchThroughGuest end-to-end (ms). */
export const VM_GUEST_HTTP_TIMEOUT_MS = 10_000;

// ============================================================================
// Errors
// ============================================================================

export type VmErrorCode =
  | "vm-not-running"
  | "port-closed"
  | "not-implemented"
  | "timeout"
  | "asset-fetch-failed"
  | "state-incompatible"
  | "boot-failed";

export class VmError extends Error {
  readonly code: VmErrorCode;
  constructor(code: VmErrorCode, message?: string) {
    super(message ?? code);
    this.name = "VmError";
    this.code = code;
  }
}

// ============================================================================
// Module facade (index.ts)
// ============================================================================

export interface VmAPI {
  readonly emulator: VmEmulator;
  readonly console: VmConsole;
  readonly ports: GuestPortBridge;
  readonly state: VmStateStore;
}

/**
 * index.ts exports (fixed signatures — a single additive mount call in
 * src/ui/main.tsx would depend on them):
 *
 *   export function initVm(): VmAPI          // idempotent, cheap, NO downloads
 *   export function mountLinuxTab(el: HTMLElement): void
 *   export function getVm(): VmAPI           // throws before initVm()
 *
 * mountLinuxTab renders the panel content into `el` (the [data-panel="linux"]
 * section): a boot splash (size disclosure + "boot" button) until the user
 * boots, then the terminal + a small toolbar (pause/resume, save snapshot,
 * power off, open-ports readout). Booting NEVER starts on page load — the
 * multi-MB asset download is user-initiated.
 */
export type VmIndexExports = {
  initVm: () => VmAPI;
  mountLinuxTab: (el: HTMLElement) => void;
  getVm: () => VmAPI;
};
```
