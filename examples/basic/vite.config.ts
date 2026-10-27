import { defineConfig } from 'vite'

export default defineConfig({
  // movi-player finds movi.wasm next to its own script (import.meta.url). Vite's dependency
  // pre-bundling moves that script and loses the file, so keep it out of pre-bundling.
  optimizeDeps: { exclude: ['movi-player'] },
})
