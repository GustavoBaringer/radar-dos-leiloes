import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import { chromium } from "playwright-core"

const url = process.argv[2] ?? "http://localhost:13000"
const outDir = process.argv[3] ?? "shots"

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
]

function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const cache = path.join(homedir(), ".cache", "ms-playwright")
  if (!existsSync(cache)) return null
  const rev = (d) => Number(d.split("-").pop())
  const candidates = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((a, b) => rev(b) - rev(a))
  for (const dir of candidates) {
    for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome"]) {
      const exe = path.join(cache, dir, rel)
      if (existsSync(exe)) return exe
    }
  }
  return null
}

const executablePath = findChromium()
if (!executablePath) {
  console.error("Chromium não encontrado em ~/.cache/ms-playwright. Rode: npx playwright@latest install chromium (ou defina CHROME_PATH).")
  process.exit(2)
}

mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ executablePath })
const errors = []

for (const vp of VIEWPORTS) {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    ignoreHTTPSErrors: true,
  })
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`[console:${vp.name}] ${msg.text()}`)
  })
  page.on("pageerror", (err) => errors.push(`[pageerror:${vp.name}] ${err.message}`))

  await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 }).catch(async () => {
    await page.goto(url, { waitUntil: "load", timeout: 30_000 })
  })
  await page.waitForTimeout(1200)
  // fullPage via CDP não gera scroll real: sem rolar antes, animações once (ScrollTrigger) ficam presas em opacity 0 no PNG
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let y = 0
      const step = () => {
        y += 600
        window.scrollTo(0, y)
        if (y < document.body.scrollHeight) setTimeout(step, 120)
        else {
          window.scrollTo(0, 0)
          setTimeout(resolve, 500)
        }
      }
      step()
    })
  })
  const file = path.join(outDir, `shot-${vp.name}-${vp.width}.png`)
  await page.screenshot({ path: file, fullPage: true })
  console.log(`ok ${file}`)
  await page.close()
}

await browser.close()

if (errors.length > 0) {
  console.error(`\n${errors.length} erro(s) de console/página:`)
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}
console.log("console limpo")
