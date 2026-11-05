import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const internalHost = process.env.TAURI_DEV_HOST || "localhost";

const nextConfig: NextConfig = {
  // Tauri has no Node.js server, so ship a static export (SSG)
  output: "export",
  // next/image optimization needs a server; disable it for static export
  images: {
    unoptimized: true,
  },
  // Point assets at the dev server so `tauri dev` resolves them correctly
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
  // cacheComponents / partialPrefetching enable PPR, which static export does not support
  reactCompiler: true,
  experimental: {
    // The persisted dev cache replays the @tailwindcss/turbopack output across
    // restarts and misses classes from files added since, so keep dev uncached.
    turbopackFileSystemCacheForDev: false,
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
