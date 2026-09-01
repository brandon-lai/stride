import type { NextConfig } from "next";

/** §1: "No server-side component. Everything runs client-side." */
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
};

export default nextConfig;
