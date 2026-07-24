import { defineConfig } from "vite";

// Vite project root is visualization/app/. The exported data lives one
// level up at visualization/public/ (see exportForViz.m's default outDir),
// so publicDir points there instead of the Vite-conventional ./public --
// this keeps the file layout exactly as specified in VISUALIZATION_PLAN.md
// §5 (export/, app/, public/ as siblings) rather than nesting data inside
// app/.
//
// base: relative paths ("./") so the built site works when served from a
// GitHub Pages project subpath (https://<user>.github.io/<repo>/) as well
// as a custom domain at the root -- avoids hardcoding either.
export default defineConfig({
  publicDir: "../public",
  base: "./",
  build: {
    outDir: "dist",
  },
});
