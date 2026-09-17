import { fileURLToPath, URL } from "node:url"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 13000,
    // O app consome a API e os estáticos do Fastify (4500). Sem o proxy, o dev
    // server responde 200 com a tela vazia — que é o modo silencioso de falhar:
    // a porta sobe, o HTML chega e nenhum dado aparece.
    proxy: {
      "/api": { target: "http://localhost:4500", changeOrigin: true },
      "/ws": { target: "ws://localhost:4500", ws: true },
      "/nopic.svg": "http://localhost:4500",
      "/nopic-imovel.svg": "http://localhost:4500",
      "/sw.js": "http://localhost:4500",
      "/ca.crt": "http://localhost:4500",
    },
  },
  preview: { host: "0.0.0.0", port: Number(process.env.PORT) || 13000 },
})
