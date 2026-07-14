/**
 * burrow — src/npm/types.ts
 * OWNED BY: resolver agent. Shared shapes for the in-browser npm installer.
 * Sibling npm modules (downloader/extractor/linker/installer) import from
 * here; the shapes below the "SHARED" banner are the cross-agent contract
 * and must not change. Packument types further down are resolver-flavored
 * but exported for anyone who needs raw registry metadata.
 */

// ============================================================================
// SHARED shapes (verbatim per the npm-module contract — do not edit)
// ============================================================================

export interface ResolvedPackage {
  name: string;
  version: string;
  tarballUrl: string;
  integrity?: string;
  dependencies: Record<string, string>;
}

/** packages deduped by name@version, topologically ordered parents-first */
export interface InstallPlan {
  packages: ResolvedPackage[];
  requested: Record<string, string>;
}

export interface InstallProgress {
  phase: "resolve" | "download" | "extract" | "link";
  detail: string;
  done: number;
  total: number;
}

export interface InstallReport {
  installed: { name: string; version: string }[];
  bytes: number;
  ms: number;
  warnings: string[];
}

/**
 * Registered in the contract registry under key "npm" (additive extension —
 * the installer agent performs the registration).
 */
export interface NpmInstaller {
  install(cwd: string, onProgress?: (p: InstallProgress) => void): Promise<InstallReport>;
  add(
    cwd: string,
    spec: string,
    opts: { dev?: boolean },
    onProgress?: (p: InstallProgress) => void,
  ): Promise<InstallReport>;
}

// ============================================================================
// Resolver additions (safe to import, may grow additively)
// ============================================================================

/** InstallPlan plus the warnings gathered while resolving (skipped peers etc.). */
export interface ResolvedInstallPlan extends InstallPlan {
  warnings: string[];
}

// ============================================================================
// npm registry packument shapes (abbreviated install metadata,
// Accept: application/vnd.npm.install-v1+json)
// ============================================================================

export interface PackumentDist {
  tarball: string;
  integrity?: string;
  shasum?: string;
  fileCount?: number;
  unpackedSize?: number;
}

export interface PackumentVersion {
  name: string;
  version: string;
  dist: PackumentDist;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[] | boolean;
  bin?: Record<string, string> | string;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
  hasInstallScript?: boolean;
}

export interface Packument {
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, PackumentVersion>;
  modified?: string;
}

/** Injectable packument source (fetchPackument by default; fixtures in tests). */
export type PackumentSource = (name: string) => Promise<Packument>;
