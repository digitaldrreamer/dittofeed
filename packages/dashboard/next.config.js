const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: "/dashboard",
  output: process.env.NEXT_STANDALONE !== "false" ? "standalone" : undefined,
  pageExtensions: ["page.tsx", "page.ts"],
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["isomorphic-lib", "backend-lib"],
  eslint: {
    // already performed in CI, redundant
    ignoreDuringBuilds: true,
  },
  swcMinify: true,
  images: {
    domains: ["*"],
  },
  async headers() {
    return [
      {
        // Apply CORS headers to /dashboard/public path
        source: "/public/:path*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
  async redirects() {
    return [
      // {
      //   // Redirect root to journeys within the dashboard basePath
      //   source: "/",
      //   destination: "/journeys",
      //   permanent: false,
      // },
      // Remove the conflicting second redirect or modify it if needed
      {
        source: "/",
        destination: "/dashboard",
        basePath: false,
        permanent: false,
      },
    ];
  },
  experimental: {
    instrumentationHook: true,
    outputFileTracingRoot: path.join(__dirname, "../../"),
    // Removed newNextLinkBehavior as it's no longer valid
  },
};

console.log("nextConfig", nextConfig);
module.exports = nextConfig;