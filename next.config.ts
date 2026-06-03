import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the project as the Turbopack root so an unrelated lockfile in a parent
  // directory isn't mistaken for the workspace root.
  turbopack: {
    root: import.meta.dirname,
  },
};

export default nextConfig;
