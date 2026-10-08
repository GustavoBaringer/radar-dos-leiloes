import { Plugin } from "@opencode/plugin"
import { execFileSync } from "child_process"
import fs from "fs"

const VAULT = "/mnt/c/Users/gustavo.pereira01/ObsidianVault"
const SEARCH_PY = "/mnt/c/Users/gustavo.pereira01/.claude/hooks/vault-search.py"
const CAPTURE_PY = "/mnt/c/Users/gustavo.pereira01/.claude/hooks/vault-capture.py"

function runPy(script: string, event: any): string {
  try {
    return execFileSync("python3", [script], {
      input: JSON.stringify(event),
      encoding: "utf-8",
      env: { ...process.env, VAULT_DIR: VAULT },
    }).trim()
  } catch {
    return ""
  }
}

export default Plugin.define({
  id: "memory-vault-hooks",
  async setup(ctx) {
    const promptHook = await ctx.session.hook("prompt", (event: any) => {
      // espelha o UserPromptSubmit do Claude: injeta contexto procurado no vault
      const contexto = runPy(SEARCH_PY, event)
      if (contexto) {
        event.metadata = { ...event.metadata, vaultContext: contexto }
      }
    })

    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type === "session.execution.succeeded") {
          // espelha o Stop do Claude: registra troca para ser promovida depois
          runPy(CAPTURE_PY, event)
        }
      }
    })()

    return () => {
      controller.abort()
      void promptHook.dispose()
    }
  },
})
