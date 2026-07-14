/** Burrow — small shared UI helpers (src/ui internal). */
import { WORKSPACE_ROOT } from "../contract/types.ts";

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function extOf(path: string): string {
  const name = basename(path);
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

/** /home/user/x → ~/x */
export function tildify(path: string): string {
  if (path === WORKSPACE_ROOT) return "~";
  if (path.startsWith(`${WORKSPACE_ROOT}/`)) return `~${path.slice(WORKSPACE_ROOT.length)}`;
  return path || "/";
}

export function decodeText(buf: Uint8Array): string {
  return new TextDecoder().decode(buf);
}

/** NUL byte in the first 8 KB → treat as binary. */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function must(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[burrow/ui] missing element #${id}`);
  return el;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
