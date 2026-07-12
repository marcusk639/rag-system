import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Produces a minimal, self-contained .next/standalone/ server bundle
  // (with file-traced node_modules resolved, including workspace deps) —
  // required for the Docker production image; see apps/web/Dockerfile.
  output: "standalone",
  // Next.js auto-detects the monorepo root by walking up for a lockfile,
  // which is unreliable (e.g. a stray lockfile elsewhere on a dev machine's
  // filesystem can win) and produces a standalone output path that mirrors
  // whatever absolute path the build happened to run at. Pin it explicitly
  // to the actual pnpm workspace root (two levels up from this file) so the
  // build is reproducible across machines/CI and `.next/standalone/server.js`
  // lands at a predictable path the Dockerfile can rely on.
  outputFileTracingRoot: path.join(__dirname, "../.."),
};

export default nextConfig;
