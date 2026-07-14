export type CommandSource = "interactive" | "programmatic" | "suggestion";

export interface CommandScope {
  projectKey: string;
  projectRoot: string;
  cwd: string;
}

export interface CommandRunInput extends CommandScope {
  command: string;
  exitCode: number;
  source: CommandSource;
}

export interface CommandStat {
  projectKey: string;
  cwd: string;
  command: string;
  uses: number;
  interactiveUses: number;
  successes: number;
  failures: number;
  accepted: number;
  lastUsedAt: number;
}

export interface RecentCommandRun {
  projectKey: string;
  cwd: string;
  command: string;
  exitCode: number;
  source: CommandSource;
  at: number;
}

export interface RankedCommand {
  command: string;
  score: number;
  source: "history" | "transition" | "project" | "general";
}

export interface RankRequest extends CommandScope {
  prefix: string;
  projectCandidates?: readonly string[];
  generalCandidates?: readonly string[];
  limit?: number;
}

interface PersistedCommandMemory {
  version: 1;
  stats: CommandStat[];
  recent: RecentCommandRun[];
}

export interface CommandMemoryStorage {
  load(): Promise<unknown>;
  save(value: PersistedCommandMemory): Promise<void>;
  clear(): Promise<void>;
}

const VERSION = 1 as const;
const MAX_STATS = 1_500;
const MAX_RECENT = 250;
const SAVE_DEBOUNCE_MS = 180;
const MAX_COMMAND_LENGTH = 800;

const SECRET_ASSIGNMENT =
  /(?:^|\s)(?:[A-Z0-9_]*(?:TOKEN|PASSWORD|PASSWD|SECRET|API_KEY|APIKEY)[A-Z0-9_]*)\s*=\s*\S+/i;
const SECRET_FLAG = /--(?:password|passwd|token|secret|api[-_]?key)(?:=|\s+)\S+/i;
const AUTH_URL = /https?:\/\/[^\s/@]+(?::[^\s/@]*)?@/i;
const AUTH_HEADER = /(?:authorization|proxy-authorization|x-api-key)\s*:\s*\S+/i;
const USER_PASSWORD = /(?:^|\s)(?:-u|--user)(?:=|\s+)\S+:\S+/i;
const NPM_TOKEN = /(?:^|\s)[^\s]*_authToken(?:=|\s+)\S+/i;

function cleanCommand(raw: string): string | null {
  const command = raw.trim();
  if (!command || command.length > MAX_COMMAND_LENGTH || /[\x00-\x1f\x7f-\x9f]/.test(command)) return null;
  return command;
}

export function commandLooksSensitive(command: string): boolean {
  return (
    SECRET_ASSIGNMENT.test(command) ||
    SECRET_FLAG.test(command) ||
    AUTH_URL.test(command) ||
    AUTH_HEADER.test(command) ||
    USER_PASSWORD.test(command) ||
    NPM_TOKEN.test(command)
  );
}

function statKey(projectKey: string, cwd: string, command: string): string {
  return `${projectKey}\0${cwd}\0${command}`;
}

function isSource(value: unknown): value is CommandSource {
  return value === "interactive" || value === "programmatic" || value === "suggestion";
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function decodePersisted(raw: unknown): PersistedCommandMemory | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== VERSION || !Array.isArray(value.stats) || !Array.isArray(value.recent)) return null;

  const stats: CommandStat[] = [];
  for (const item of value.stats.slice(-MAX_STATS)) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const command = typeof row.command === "string" ? cleanCommand(row.command) : null;
    if (
      command === null ||
      commandLooksSensitive(command) ||
      typeof row.projectKey !== "string" ||
      typeof row.cwd !== "string" ||
      !finiteNonNegative(row.uses) ||
      !finiteNonNegative(row.interactiveUses) ||
      !finiteNonNegative(row.successes) ||
      !finiteNonNegative(row.failures) ||
      !finiteNonNegative(row.accepted) ||
      !finiteNonNegative(row.lastUsedAt)
    ) {
      continue;
    }
    stats.push({
      projectKey: row.projectKey,
      cwd: row.cwd,
      command,
      uses: row.uses,
      interactiveUses: row.interactiveUses,
      successes: row.successes,
      failures: row.failures,
      accepted: row.accepted,
      lastUsedAt: row.lastUsedAt,
    });
  }

  const recent: RecentCommandRun[] = [];
  for (const item of value.recent.slice(-MAX_RECENT)) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as Record<string, unknown>;
    const command = typeof row.command === "string" ? cleanCommand(row.command) : null;
    if (
      command === null ||
      commandLooksSensitive(command) ||
      typeof row.projectKey !== "string" ||
      typeof row.cwd !== "string" ||
      !finiteNonNegative(row.exitCode) ||
      !finiteNonNegative(row.at) ||
      !isSource(row.source)
    ) {
      continue;
    }
    recent.push({
      projectKey: row.projectKey,
      cwd: row.cwd,
      command,
      exitCode: row.exitCode,
      source: row.source,
      at: row.at,
    });
  }

  return { version: VERSION, stats, recent };
}

function directoryDistance(from: string, to: string): number {
  const a = from.split("/").filter(Boolean);
  const b = to.split("/").filter(Boolean);
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common++;
  return a.length + b.length - common * 2;
}

function scopeScore(stat: Pick<CommandStat, "projectKey" | "cwd">, request: CommandScope): number {
  if (stat.projectKey !== request.projectKey) return 2;
  if (stat.cwd === request.cwd) return 80;
  if (request.cwd.startsWith(`${stat.cwd}/`)) {
    return Math.max(32, 52 - directoryDistance(stat.cwd, request.cwd) * 4);
  }
  if (stat.cwd.startsWith(`${request.cwd}/`)) {
    return Math.max(12, 24 - directoryDistance(stat.cwd, request.cwd) * 3);
  }
  return 12;
}

function transitionScopeScore(run: RecentCommandRun, request: CommandScope): number {
  if (run.projectKey !== request.projectKey) return 4;
  if (run.cwd === request.cwd) return 54;
  if (request.cwd.startsWith(`${run.cwd}/`)) return 34;
  return 18;
}

export class CommandMemory {
  readonly #storage: CommandMemoryStorage | null;
  readonly #now: () => number;
  readonly #stats = new Map<string, CommandStat>();
  #recent: RecentCommandRun[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;
  #saveQueue: Promise<void> = Promise.resolve();
  #revision = 0;

  constructor(storage: CommandMemoryStorage | null, options?: { now?: () => number }) {
    this.#storage = storage;
    this.#now = options?.now ?? Date.now;
  }

  async load(): Promise<void> {
    if (this.#storage === null) return;
    try {
      const decoded = decodePersisted(await this.#storage.load());
      if (decoded === null) return;
      this.#stats.clear();
      for (const stat of decoded.stats) {
        this.#stats.set(statKey(stat.projectKey, stat.cwd, stat.command), stat);
      }
      this.#recent = decoded.recent;
      this.#revision++;
    } catch (error) {
      console.warn("[shell] command memory could not be restored", error);
    }
  }

  get revision(): number {
    return this.#revision;
  }

  history(limit = 200): string[] {
    return this.#recent
      .filter((run) => run.source !== "programmatic")
      .slice(-Math.max(0, limit))
      .map((run) => run.command);
  }

  recentFor(scope: CommandScope, limit = 12): RecentCommandRun[] {
    const sameProject = this.#recent.filter((run) => run.projectKey === scope.projectKey);
    const source = sameProject.length > 0 ? sameProject : this.#recent;
    return source.slice(-Math.max(0, limit)).reverse();
  }

  lastRun(scope: CommandScope): RecentCommandRun | null {
    for (let i = this.#recent.length - 1; i >= 0; i--) {
      const run = this.#recent[i]!;
      if (run.projectKey === scope.projectKey) return run;
    }
    return this.#recent.at(-1) ?? null;
  }

  #lastUserRun(scope: CommandScope): RecentCommandRun | null {
    let fallback: RecentCommandRun | null = null;
    for (let i = this.#recent.length - 1; i >= 0; i--) {
      const run = this.#recent[i]!;
      if (run.source === "programmatic") continue;
      fallback ??= run;
      if (run.projectKey === scope.projectKey) return run;
    }
    return fallback;
  }

  record(input: CommandRunInput): void {
    const command = cleanCommand(input.command);
    if (command === null || commandLooksSensitive(command)) return;
    const now = this.#now();
    const key = statKey(input.projectKey, input.cwd, command);
    const stat = this.#stats.get(key) ?? {
      projectKey: input.projectKey,
      cwd: input.cwd,
      command,
      uses: 0,
      interactiveUses: 0,
      successes: 0,
      failures: 0,
      accepted: 0,
      lastUsedAt: now,
    };
    stat.uses++;
    if (input.source !== "programmatic") stat.interactiveUses++;
    if (input.exitCode === 0) stat.successes++;
    else stat.failures++;
    stat.lastUsedAt = now;
    this.#stats.set(key, stat);

    this.#recent.push({
      projectKey: input.projectKey,
      cwd: input.cwd,
      command,
      exitCode: input.exitCode,
      source: input.source,
      at: now,
    });
    if (this.#recent.length > MAX_RECENT) this.#recent.splice(0, this.#recent.length - MAX_RECENT);
    this.#pruneStats();
    this.#revision++;
    this.#scheduleSave();
  }

  markAccepted(scope: CommandScope, rawCommand: string): void {
    const command = cleanCommand(rawCommand);
    if (command === null || commandLooksSensitive(command)) return;
    const key = statKey(scope.projectKey, scope.cwd, command);
    const now = this.#now();
    const stat = this.#stats.get(key) ?? {
      projectKey: scope.projectKey,
      cwd: scope.cwd,
      command,
      uses: 0,
      interactiveUses: 0,
      successes: 0,
      failures: 0,
      accepted: 0,
      lastUsedAt: now,
    };
    stat.accepted++;
    stat.lastUsedAt = now;
    this.#stats.set(key, stat);
    this.#revision++;
    this.#scheduleSave();
  }

  rank(request: RankRequest): RankedCommand[] {
    const prefix = request.prefix;
    if (!prefix || /[\x00-\x1f\x7f-\x9f]/.test(prefix)) return [];
    const ranked = new Map<string, RankedCommand>();
    const add = (raw: string, score: number, source: RankedCommand["source"]): void => {
      const command = cleanCommand(raw);
      if (command === null || command === prefix || !command.startsWith(prefix)) return;
      const previous = ranked.get(command);
      if (!previous || score > previous.score) ranked.set(command, { command, score, source });
    };

    const now = this.#now();
    for (const stat of this.#stats.values()) {
      if (!stat.command.startsWith(prefix) || stat.command === prefix) continue;
      const interactiveWeight = stat.interactiveUses + (stat.uses - stat.interactiveUses) * 0.25;
      const ageDays = Math.max(0, now - stat.lastUsedAt) / 86_400_000;
      const recency = 12 * Math.exp(-ageDays / 21);
      const successRate = stat.uses === 0 ? 0 : stat.successes / stat.uses;
      const score =
        scopeScore(stat, request) +
        Math.log2(interactiveWeight + 1) * 8 +
        recency +
        successRate * 5 +
        Math.min(12, stat.accepted * 2);
      add(stat.command, score, "history");
    }

    const last = this.#lastUserRun(request);
    if (last !== null) {
      const boosts = new Map<string, number>();
      for (let i = 1; i < this.#recent.length; i++) {
        const previous = this.#recent[i - 1]!;
        const next = this.#recent[i]!;
        if (previous.source === "programmatic" || next.source === "programmatic" || previous.command !== last.command) {
          continue;
        }
        const ageDays = Math.max(0, now - next.at) / 86_400_000;
        const boost = transitionScopeScore(next, request) * 0.35 + 16 * Math.exp(-ageDays / 14);
        boosts.set(next.command, (boosts.get(next.command) ?? 0) + boost);
      }
      for (const [command, rawBoost] of boosts) {
        const boost = Math.min(48, rawBoost);
        const previous = ranked.get(command);
        if (previous) {
          previous.score += boost;
          previous.source = "transition";
        } else {
          add(command, boost, "transition");
        }
      }
    }

    for (const command of request.projectCandidates ?? []) add(command, 42, "project");
    for (const command of request.generalCandidates ?? []) add(command, 8, "general");

    return [...ranked.values()]
      .sort((a, b) => b.score - a.score || a.command.length - b.command.length || a.command.localeCompare(b.command))
      .slice(0, request.limit ?? 8);
  }

  attachLifecycle(): () => void {
    if (typeof document === "undefined" || typeof window === "undefined") return () => {};
    const visibility = (): void => {
      if (document.visibilityState === "hidden") void this.flush();
    };
    const pagehide = (): void => void this.flush();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", pagehide);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", pagehide);
    };
  }

  flush(): Promise<void> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (!this.#dirty || this.#storage === null) return this.#saveQueue;
    this.#dirty = false;
    const value: PersistedCommandMemory = {
      version: VERSION,
      stats: [...this.#stats.values()],
      recent: this.#recent.slice(),
    };
    this.#saveQueue = this.#saveQueue.then(async () => {
      try {
        await this.#storage?.save(value);
      } catch (error) {
        this.#dirty = true;
        console.warn("[shell] command memory could not be saved", error);
      }
    });
    return this.#saveQueue;
  }

  #scheduleSave(): void {
    if (this.#storage === null) return;
    this.#dirty = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  #pruneStats(): void {
    if (this.#stats.size <= MAX_STATS) return;
    const oldest = [...this.#stats.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (let i = 0; i < oldest.length - MAX_STATS; i++) this.#stats.delete(oldest[i]![0]);
  }
}

export class MemoryCommandMemoryStorage implements CommandMemoryStorage {
  value: unknown;
  saveCount = 0;

  constructor(initial: unknown = null) {
    this.value = initial;
  }

  async load(): Promise<unknown> {
    return this.value === null ? null : structuredClone(this.value);
  }

  async save(value: PersistedCommandMemory): Promise<void> {
    this.saveCount++;
    this.value = structuredClone(value);
  }

  async clear(): Promise<void> {
    this.value = null;
  }
}

const DB_NAME = "burrow-command-memory";
const DB_VERSION = 1;
const STORE = "state";
const STATE_KEY = "commands";

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

class IndexedDbCommandMemoryStorage implements CommandMemoryStorage {
  #dbPromise: Promise<IDBDatabase> | null = null;

  #open(): Promise<IDBDatabase> {
    if (this.#dbPromise === null) {
      this.#dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      });
      this.#dbPromise.catch(() => {
        this.#dbPromise = null;
      });
    }
    return this.#dbPromise;
  }

  async load(): Promise<unknown> {
    const db = await this.#open();
    const tx = db.transaction(STORE, "readonly");
    const value = await requestToPromise(tx.objectStore(STORE).get(STATE_KEY));
    await transactionDone(tx);
    return value ?? null;
  }

  async save(value: PersistedCommandMemory): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, STATE_KEY);
    await transactionDone(tx);
  }

  async clear(): Promise<void> {
    const db = await this.#open();
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(STATE_KEY);
    await transactionDone(tx);
  }
}

export function createCommandMemoryStorage(): CommandMemoryStorage | null {
  try {
    if (typeof indexedDB === "undefined" || indexedDB === null) return null;
    return new IndexedDbCommandMemoryStorage();
  } catch {
    return null;
  }
}
