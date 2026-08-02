import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /*
   * MediaPipe and its canvas backend are optional, loaded at runtime, and ship
   * native/WASM assets the bundler can't usefully process. Marking them
   * external keeps them out of the trace and out of the serverless bundle.
   */
  serverExternalPackages: [
    "@tensorflow/tfjs",
    "@tensorflow-models/pose-detection",
    "@napi-rs/canvas",
  ],
};

export default nextConfig;
