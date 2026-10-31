import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Coolify (Docker) construye con NEXT_OUTPUT=standalone; Vercel no lo usa.
  ...(process.env.NEXT_OUTPUT === "standalone" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
