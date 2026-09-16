/**
 * Autenticação ponta a ponta: portão de senha, OIDC e — o que mais importa —
 * isolamento entre contas.
 *
 * Antes desta rodada nada tinha dono: quem entrava via e apagava os alertas de
 * todo mundo. Um teste que só verificasse "consegui entrar" ficaria verde com
 * esse defeito inteiro no lugar, então a asserção central é a de vazamento.
 */
import { chromium } from 'playwright-core';
import { zeraFreioDeLogin } from './_teste-comum.mjs';

const BASE = process.env.BASE ?? 'http://localhost:4500';
const KC = process.env.KC ?? 'http://localhost:8081';
const b = await chromium.launch({ headless: true, executablePath: '/home/gustavopereira/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' });
const falhas = [];
const ok = (cond, msg) => (cond ? console.log(`  PASSA  ${msg}`) : falhas.push(msg));

zeraFreioDeLogin();

/** Entra por OIDC e devolve a página já autenticada. */
async function entrarPorOidc(email, senha) {
  const p = await (await b.newContext()).newPage();
  await p.goto(`${BASE}/auth/login?de=/alertas`);
  await p.waitForSelector('#username', { timeout: 20000 });
  await p.fill('#username', email);
  await p.fill('#password', senha);
  await p.click('#kc-login');
  for (let i = 0; i < 3; i++) {
    await p.waitForLoadState('load');
    if (new URL(p.url()).host !== new URL(KC).host) break;
    const precisaPerfil = await p.locator('#kc-update-profile-form, input[name="lastName"]').count();
    if (!precisaPerfil) break;
    for (const [campo, valor] of [['firstName', 'Teste'], ['lastName', 'de Teste']]) {
      const alvo = p.locator(`input[name="${campo}"]`);
      if (await alvo.count()) await alvo.fill(valor);
    }
    await Promise.all([p.waitForLoadState('load'), p.click('button[type=submit], input[type=submit]')]);
  }
  await p.waitForURL((u) => u.host !== new URL(KC).host, { timeout: 25000 });
  return p;
}

console.log('\n1. Portão de senha continua funcionando');
{
  const p = await (await b.newContext()).newPage();
  await p.goto(`${BASE}/login`);
  await p.fill('#usuario', process.env.APP_USUARIO);
  await p.fill('#senha', process.env.APP_SENHA);
  await Promise.all([p.waitForNavigation(), p.click('button[type=submit]')]);
  const me = await p.evaluate(() => fetch('/api/me').then((r) => r.json()));
  ok(p.url().endsWith('/busca'), `senha leva para /busca (foi para ${p.url()})`);
  ok(me.papel === 'admin', `papel admin pelo portão (veio "${me.papel}")`);
  ok(me.conta?.porProvedor === false, 'conta do portão não é marcada como de provedor');
  await p.close();
}

console.log('\n2. Login por OIDC (Keycloak)');
let sub1;
{
  const p = await entrarPorOidc('gustavo@radar.test', 'SenhaDeTeste123');
  const me = await p.evaluate(() => fetch('/api/me').then((r) => r.json()));
  ok(p.url().endsWith('/alertas'), `volta para o destino pretendido (foi para ${p.url()})`);
  ok(me.conta?.porProvedor === true, 'a conta veio do provedor');
  ok(me.conta?.email === 'gustavo@radar.test', `e-mail do token virou a conta (veio "${me.conta?.email}")`);
  ok(me.papel === 'admin', `a role radar-admin do realm virou papel admin (veio "${me.papel}")`);
  sub1 = me.conta?.id;
  // Cria um alerta nesta conta para o teste de isolamento.
  const r = await p.evaluate(() =>
    fetch('/api/alerts', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'SEGREDO DO GUSTAVO', q: 'hilux' }) }).then((x) => x.json()));
  ok(r.id != null, 'alerta criado pela conta A');
  globalThis.alertaDeA = r.id;
  await p.close();
}

console.log('\n3. A conta comum NÃO recebe papel de admin');
{
  const p = await entrarPorOidc('comum@radar.test', 'SenhaDeTeste123');
  const me = await p.evaluate(() => fetch('/api/me').then((r) => r.json()));
  ok(me.papel === 'comum', `sem a role, o papel é comum (veio "${me.papel}")`);
  ok(me.conta?.id !== sub1, 'é outra conta no banco');

  console.log('\n4. Isolamento: a conta B não vê nem apaga o alerta da conta A');
  const meus = await p.evaluate(() => fetch('/api/alerts').then((r) => r.json()));
  ok(Array.isArray(meus) && meus.length === 0, `a lista de B vem vazia (veio ${meus?.length} alerta(s))`);
  ok(!JSON.stringify(meus).includes('SEGREDO DO GUSTAVO'), 'o alerta de A não aparece para B');
  const del = await p.evaluate((id) => fetch(`/api/alerts/${id}`, { method: 'DELETE' }).then((r) => r.status), globalThis.alertaDeA);
  ok(del === 404, `apagar o alerta de A devolve 404 (devolveu ${del})`);
  const hits = await p.evaluate(() => fetch('/api/alerts/hits').then((r) => r.json()));
  ok(Array.isArray(hits) && hits.length === 0, `os disparos de B vêm vazios (veio ${hits?.length})`);
  await p.close();
}

console.log('\n5. O alerta de A sobreviveu à tentativa de B');
{
  const p = await entrarPorOidc('gustavo@radar.test', 'SenhaDeTeste123');
  const meus = await p.evaluate(() => fetch('/api/alerts').then((r) => r.json()));
  ok(meus.some((a) => a.label === 'SEGREDO DO GUSTAVO'), 'A continua com o alerta dele');
  await p.evaluate((id) => fetch(`/api/alerts/${id}`, { method: 'DELETE' }), globalThis.alertaDeA);
  const depois = await p.evaluate(() => fetch('/api/alerts').then((r) => r.json()));
  ok(!depois.some((a) => a.label === 'SEGREDO DO GUSTAVO'), 'e consegue apagar o próprio');
  await p.close();
}

console.log('\n6. Sair encerra a sessão');
{
  const p = await entrarPorOidc('comum@radar.test', 'SenhaDeTeste123');
  await p.goto(`${BASE}/auth/logout`);
  await p.waitForLoadState('load');
  const passouPeloProvedor = p.url().includes(new URL(KC).host) || p.url().includes('/login');
  ok(passouPeloProvedor, `o logout encerra também no provedor (terminou em ${p.url()})`);
  // A asserção da sessão tem de sair da NOSSA origem.
  await p.goto(`${BASE}/login`);
  const r = await p.evaluate(() => fetch('/api/alerts').then((x) => x.status));
  ok(r === 401, `depois de sair, a API responde 401 (respondeu ${r})`);
  const cookieSessao = (await p.context().cookies()).find((c) => c.name === 'radar_sessao');
  ok(!cookieSessao?.value, 'o cookie de sessão foi apagado');
  await p.close();
}

console.log('\n7. Freio de força bruta no portão de senha');
{
  const codigos = [];
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`${BASE}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `usuario=admin&senha=errada${i}`, redirect: 'manual',
    });
    codigos.push(r.status);
  }
  ok(codigos.includes(429), `bloqueia depois de várias tentativas (códigos: ${codigos.join(',')})`);
  ok(codigos.filter((c) => c === 401).length <= 8, `no máximo 8 tentativas antes do bloqueio (foram ${codigos.filter((c) => c === 401).length})`);
}

await b.close();
console.log(falhas.length ? `\nFALHOU:\n- ${falhas.join('\n- ')}` : '\nVERDE: todas as asserções passaram.');
process.exit(falhas.length ? 1 : 0);
