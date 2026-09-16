/**
 * Utilidades compartilhadas pelos testes que precisam entrar no sistema.
 */
import { execSync } from 'node:child_process';

/**
 * Zera o contador de tentativas de login.
 *
 * O freio de força bruta é por IP e dura 15 minutos. Todo teste que roda depois
 * do teste-auth (que termina de propósito com 12 senhas erradas) tomava 429 no
 * login e falhava com sintoma enganoso: "a home não renderizou cartão", quando
 * na verdade nem tinha entrado. Isolar aqui é obrigação do teste — quem prova
 * que o freio funciona é o teste-auth, que o exercita de propósito.
 */
export function zeraFreioDeLogin() {
  try {
    execSync(`docker exec leilao-redis sh -c 'redis-cli --scan --pattern "login:falha:*" | xargs -r redis-cli del'`, {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    /* sem Redis o freio não conta nada, então não há o que zerar */
  }
}

/** Entra pelo portão de senha e devolve a página autenticada. */
export async function entrarComSenha(page, base) {
  zeraFreioDeLogin();
  await page.goto(`${base}/login`);
  await page.fill('#usuario', process.env.APP_USUARIO);
  await page.fill('#senha', process.env.APP_SENHA);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]')]);
  // Entrou de fato? Sem esta checagem, um 429 vira timeout de seletor três
  // passos depois e o teste acusa a tela errada.
  if (page.url().includes('/login') || page.url().includes('/api/login')) {
    throw new Error(`login falhou: terminou em ${page.url()} (429 do freio? senha errada?)`);
  }
  return page;
}
