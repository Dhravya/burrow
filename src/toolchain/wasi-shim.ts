/**
 * Burrow src/toolchain — minimal wasi_snapshot_preview1 shim, just enough for
 * Bun's transpiler compiled to wasm32-wasip1 (reactor). stdout/stderr are
 * routed to callbacks. It mirrors what the old (Zig-era) `bun-wasm` npm
 * package did with its hand-rolled WASI import object, updated for wasip1
 * naming.
 */

const WASI_ESUCCESS = 0;
const WASI_EBADF = 8;
const WASI_ENOSYS = 52;

// i64 params arrive as bigint through the wasm-JS boundary, hence any[].
type WasiFn = (...args: any[]) => number;

export interface WasiShim {
  imports: Record<string, WasiFn>;
  setMemory(memory: WebAssembly.Memory): void;
}

export function makeWasi(io: { onStdout(text: string): void; onStderr(text: string): void }): WasiShim {
  let memory: WebAssembly.Memory | null = null;
  const decoder = new TextDecoder();

  const view = () => new DataView((memory as WebAssembly.Memory).buffer);
  const bytes = () => new Uint8Array((memory as WebAssembly.Memory).buffer);

  const imports: Record<string, WasiFn> = {
    args_get() {
      return WASI_ESUCCESS;
    },
    args_sizes_get(argcPtr: number, argvBufSizePtr: number) {
      view().setUint32(argcPtr, 0, true);
      view().setUint32(argvBufSizePtr, 0, true);
      return WASI_ESUCCESS;
    },
    environ_get() {
      return WASI_ESUCCESS;
    },
    environ_sizes_get(envcPtr: number, envBufSizePtr: number) {
      view().setUint32(envcPtr, 0, true);
      view().setUint32(envBufSizePtr, 0, true);
      return WASI_ESUCCESS;
    },
    clock_res_get(_id: number, resPtr: number) {
      view().setBigUint64(resPtr, 1_000_000n, true);
      return WASI_ESUCCESS;
    },
    clock_time_get(_id: number, _precision: bigint, timePtr: number) {
      view().setBigUint64(timePtr, BigInt(Math.round(performance.now() * 1e6)), true);
      return WASI_ESUCCESS;
    },
    fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) {
      const v = view();
      const b = bytes();
      let written = 0;
      let text = "";
      for (let i = 0; i < iovsLen; i++) {
        const ptr = v.getUint32(iovsPtr + i * 8, true);
        const len = v.getUint32(iovsPtr + i * 8 + 4, true);
        text += decoder.decode(b.subarray(ptr, ptr + len));
        written += len;
      }
      v.setUint32(nwrittenPtr, written, true);
      if (text.length) (fd === 2 ? io.onStderr : io.onStdout)(text);
      return WASI_ESUCCESS;
    },
    fd_read(_fd: number, _iovs: number, _iovsLen: number, nreadPtr: number) {
      view().setUint32(nreadPtr, 0, true);
      return WASI_ESUCCESS;
    },
    fd_close() {
      return WASI_ESUCCESS;
    },
    fd_fdstat_get(_fd: number, statPtr: number) {
      const v = view();
      // filetype: character_device(2) for stdio; flags/rights: permissive
      v.setUint8(statPtr, 2);
      v.setUint16(statPtr + 2, 0, true);
      v.setBigUint64(statPtr + 8, 0xffff_ffff_ffff_ffffn, true);
      v.setBigUint64(statPtr + 16, 0xffff_ffff_ffff_ffffn, true);
      return WASI_ESUCCESS;
    },
    fd_fdstat_set_flags() {
      return WASI_ESUCCESS;
    },
    fd_prestat_get() {
      return WASI_EBADF; // no preopened directories
    },
    fd_prestat_dir_name() {
      return WASI_EBADF;
    },
    fd_seek(_fd: number, _offset: bigint, _whence: number, newOffsetPtr: number) {
      view().setBigUint64(newOffsetPtr, 0n, true);
      return WASI_ESUCCESS;
    },
    fd_filestat_get() {
      return WASI_ENOSYS;
    },
    path_open() {
      return WASI_ENOSYS;
    },
    path_filestat_get() {
      return WASI_ENOSYS;
    },
    path_create_directory() {
      return WASI_ENOSYS;
    },
    path_unlink_file() {
      return WASI_ENOSYS;
    },
    path_remove_directory() {
      return WASI_ENOSYS;
    },
    path_readlink() {
      return WASI_ENOSYS;
    },
    random_get(bufPtr: number, bufLen: number) {
      // crypto.getRandomValues caps at 64 KiB per call
      const b = bytes();
      for (let off = 0; off < bufLen; off += 65536) {
        crypto.getRandomValues(b.subarray(bufPtr + off, bufPtr + Math.min(bufLen, off + 65536)));
      }
      return WASI_ESUCCESS;
    },
    poll_oneoff() {
      return WASI_ENOSYS;
    },
    sched_yield() {
      return WASI_ESUCCESS;
    },
    proc_exit(code: number): never {
      throw new Error(`wasm called proc_exit(${code})`);
    },
  };

  return {
    imports,
    setMemory(m: WebAssembly.Memory) {
      memory = m;
    },
  };
}

/**
 * Any native symbol the linker left undefined (--allow-undefined) becomes an
 * `env` import. None of them are on the transpile path; if one IS called we
 * want a loud, named error instead of silent corruption.
 */
export function makeEnvProxy(): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, name) {
        if (typeof name !== "string") return undefined;
        return (..._args: unknown[]) => {
          throw new Error(`unlinked native symbol called at runtime: ${name}`);
        };
      },
    },
  );
}
