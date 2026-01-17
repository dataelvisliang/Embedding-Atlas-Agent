# Debugging Report: Embedding Atlas Label Generation

**Date:** January 17, 2026
**Project:** Embedding Atlas + Chatbot Web App
**Status:** Resolved (Hybrid Strategy)

## 1. The Issue
When integrating the `embedding-atlas` React component into a fresh Vite application, the map rendered correctly, but the label generation process would hang indefinitely with the message **"Generating labels..."**.

## 2. Investigation Findings

### Initial Hypothesis: Worker Configuration
We suspected the library couldn't locate its web worker files (`clustering.worker.js`).
- **Action**: Copied worker files from `node_modules` to `public/` and configured `window.EMBEDDING_ATLAS_HOME`.
- **Result**: `failure`. The workers were loaded (HTTP 200), but the process still hung.

### Secondary Hypothesis: Environment / Headers
High-performance features in `embedding-atlas` (like DuckDB and clustering) require `SharedArrayBuffer`, which demands strict security headers.
- **Action**: Verified `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- **Result**: `pass`. The environment was correctly configured (`window.crossOriginIsolated` was `true`). DuckDB loaded data, implying WASM was working for the main thread, but the worker specifically failed.

### Third Hypothesis: Asset Resolution (WASM)
The clustering worker might depend on specific WASM files or internal paths that Vite's bundler wasn't resolving correctly when importing from `node_modules`.
- **Action**: Copied all `dist` assets including `.wasm` files to `public/dist` and updated the HOME path.
- **Result**: `failure`. Silent fail. No explicit error in logs, likely due to a mismatch in how the worker was instantiated (classic vs module) or how it resolved its own dependencies.

### Official Repo Check
We examined the official `embedding-atlas` repository (locally available) and confirmed it uses a complex monorepo structure where workers are instantiated via `new URL(..., import.meta.url)`. This standard Vite pattern can sometimes break when consuming the pre-bundled package in a new Vite project if the assets aren't strictly aligned.

## 3. The Fix: Hybrid Iframe Strategy
We discovered that the **Static Export** (from the Python script `print(atlas.export_html())`) produced a fully functional web app with working labels. This export uses a self-contained bundle where all internal paths are pre-resolved.

**Refined Solution:**
1.  **Asset Migration**: We moved the entire working static export (formerly `vercel-app`) to `web-app/public/atlas/`.
2.  **Iframe Integration**: Instead of fighting the fragile bundler configuration of the React component, we simply render the robust static export inside a full-screen `<iframe>` within our React app.
3.  **UI Overlay**: We overlayed the custom "Ask AI" Chat Widget on top of the iframe using higher `z-index`.

## 4. Outcome
- **Labels**: ✅ Working (Served by the static export).
- **Visualization**: ✅ Full fidelity (Official Apple renderer).
- **Chatbot**: ✅ Fully interactive React component.
- **UX**: ✅ Seamless integration, looks like a single app.

## 5. Future Considerations
- **Selection Sync**: Currently, the Chatbot doesn't know which points are selected in the iframe. To fix this, we would inject a small script into `public/atlas/index.html` that listens for Mosaic selection events and sends them to the parent window via `window.parent.postMessage()`.
- **Backend**: The Chatbot is currently a demo. It needs to be connected to a Vercel Serverless Function to call the LLM API.
