import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

const alias = { '@shared': resolve(__dirname, 'src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        // mcp.js is the stdio MCP server for external agent apps (see README)
        input: { index: resolve(__dirname, 'src/main/index.ts'), mcp: resolve(__dirname, 'src/mcp/server.ts'),
          // server.js is the always-on service with the Telegram bot (see setup/)
          server: resolve(__dirname, 'src/server/server.ts')
        }
      }
    }
  },
  preload: {
    resolve: { alias }
  },
  renderer: {
    resolve: { alias },
    worker: { format: 'es' }
  }
})
