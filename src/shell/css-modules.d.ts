/**
 * Burrow — src/shell/css-modules.d.ts
 * Bun's bundler handles CSS imports natively; these ambient declarations
 * keep `bunx tsc --noEmit` clean for them.
 */

declare module "*.css";
declare module "@wterm/dom/css";
