/**
 * A landing e o app não podem divergir de cor, fonte nem raio.
 *
 * O brief pedia "tokens numa fonte única que as duas stacks consomem", mas
 * também proibia tocar em landing.css — e fazer a landing importar um arquivo
 * novo seria tocá-la. A saída é mecânica em vez de estrutural: este teste lê os
 * DOIS arquivos e falha se um valor sair do outro. A landing continua intocada
 * e a divergência deixa de ser silenciosa.
 */
import { readFileSync } from 'node:fs';

const landing = readFileSync('../src/web/landing.css', 'utf8');
const app = readFileSync('src/styles.css', 'utf8');

/** token da landing -> token do app (@theme do Tailwind usa outro prefixo) */
const PARES = {
  '--canvas': '--brand-canvas',
  '--panel': '--brand-panel',
  '--panel-2': '--brand-panel-2',
  '--hairline': '--brand-hairline',
  '--brand': '--brand-core',
  '--brand-bright': '--brand-bright',
  '--signal': '--brand-signal',
  '--verify': '--brand-verify',
  '--bid': '--brand-gold',
  '--ink-soft': '--brand-ink-soft',
};

const valor = (css, token) => {
  // `--brand:` casaria com `--brand-bright:` sem a borda explícita.
  const m = new RegExp(`${token}\\s*:\\s*([^;]+);`).exec(css);
  return m ? m[1].trim().toLowerCase() : null;
};

let falhas = 0;
for (const [naLanding, noApp] of Object.entries(PARES)) {
  const a = valor(landing, naLanding);
  const b = valor(app, noApp);
  if (a && b && a === b) {
    console.log(`  OK    ${naLanding} = ${a}`);
  } else {
    falhas++;
    console.log(`  FALHA ${naLanding}=${a ?? '(ausente)'} != ${noApp}=${b ?? '(ausente)'}`);
  }
}

// As três fontes, com os mesmos papéis nos dois lados.
for (const fonte of ['DM Sans', 'Space Grotesk', 'JetBrains Mono']) {
  const naLanding = landing.includes(fonte);
  const noApp = app.includes(fonte);
  if (naLanding && noApp) console.log(`  OK    fonte ${fonte} nos dois`);
  else { falhas++; console.log(`  FALHA fonte ${fonte}: landing=${naLanding} app=${noApp}`); }
}

// O raio base: a landing usa --r, o app usa --radius do contrato shadcn.
const rLanding = valor(landing, '--r');
const rApp = valor(app, '--radius');
if (rLanding === rApp) console.log(`  OK    raio base = ${rApp}`);
else { falhas++; console.log(`  FALHA raio: landing --r=${rLanding} app --radius=${rApp}`); }

console.log(falhas ? `\n${falhas} divergência(s) entre a landing e o app` : '\nlanding e app com o mesmo sistema visual');
process.exit(falhas ? 1 : 0);
