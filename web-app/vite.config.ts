import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Use "/" for Vercel, "/Embedding-Atlas-Agent/" for GitHub Pages
  base: process.env.VERCEL ? "/" : "/Embedding-Atlas-Agent/",
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      // Allow serving files from linked packages
      allow: [
        '.',
        'C:/Users/liang/Desktop/ML Notebooks/embedding-atlas'
      ],
    },
  },
  plugins: [react()],
  worker: {
    format: "es",
  },
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    exclude: [
      "embedding-atlas",
      "@dataelvisliang/embedding-atlas",
      "@embedding-atlas/viewer",
      "@embedding-atlas/component",
      "@embedding-atlas/table",
      "@uwdata/mosaic-core",
      "@duckdb/duckdb-wasm"
    ],
  },
})
