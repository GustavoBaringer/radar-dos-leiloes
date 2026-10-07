export const PAGINA_LOGIN = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Entrar · Radar de Leilões</title>
<meta name="robots" content="noindex">
<style>
:root{color-scheme:dark;--brand:#2f6bff;--brand2:#5b8cff;--signal:#22d3ee;--ink:#eef3ff;--soft:#93a4c4;--line:#1e2941;--panel:#0b1120}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;background:#05070f;color:var(--ink);
     font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.split{display:flex;min-height:100svh}
.hero{position:relative;flex:1 1 75%;overflow:hidden;background:#05070f}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:46% 55%}
.hero::after{content:"";position:absolute;inset:0;
     background:linear-gradient(90deg,rgba(5,7,15,.55),rgba(5,7,15,.1) 40%,rgba(5,7,15,.55)),
     radial-gradient(60rem 40rem at 20% 10%,rgba(47,107,255,.25),transparent 60%)}
.hero-txt{position:absolute;left:clamp(28px,5vw,72px);bottom:clamp(28px,6vw,72px);right:48px;z-index:1}
.hero-txt h2{font-size:clamp(24px,2.6vw,40px);line-height:1.1;letter-spacing:-.02em;margin:0;max-width:18ch;text-wrap:balance}
.hero-txt p{margin:14px 0 0;color:var(--soft);font-size:clamp(14px,1.1vw,17px);max-width:40ch}
.hero-txt em{font-style:normal;background:linear-gradient(110deg,var(--brand2),var(--signal));-webkit-background-clip:text;background-clip:text;color:transparent}
.painel{flex:0 0 clamp(360px,35%,560px);display:flex;flex-direction:column;justify-content:center;
     padding:clamp(28px,4vw,56px);border-left:1px solid var(--line);background:rgba(8,12,24,.65);backdrop-filter:blur(8px)}
.marca{display:flex;align-items:center;gap:10px;margin-bottom:28px}
.marca .mk{position:relative;display:grid;place-items:center;width:34px;height:34px;overflow:hidden;border-radius:11px;
     border:1px solid rgba(47,107,255,.4);background:linear-gradient(150deg,#13224a,#070c18)}
.marca .mk i{width:7px;height:7px;border-radius:50%;background:var(--signal);box-shadow:0 0 10px 2px rgba(34,211,238,.8)}
.marca b{font-size:16px;letter-spacing:-.2px}
form{width:100%}
h1{font-size:22px;letter-spacing:-.02em;margin:0 0 4px}
.sub{margin:0 0 22px;color:var(--soft);font-size:13.5px}
label{display:block;font-size:12px;color:var(--soft);margin:14px 0 6px;letter-spacing:.02em}
input{width:100%;background:#05070f;border:1px solid var(--line);border-radius:10px;
      padding:12px 13px;color:var(--ink);font-size:16px}
input:focus{outline:2px solid var(--brand);outline-offset:1px;border-color:var(--brand)}
button[type=submit]{width:100%;margin-top:22px;background:var(--brand);border:0;border-radius:10px;padding:13px;
       color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:background .15s}
button[type=submit]:hover{background:var(--brand2)}
.challenge-slot{margin-top:14px;min-height:0}.challenge-slot:empty{display:none}.challenge-status{font-size:13px;color:var(--soft);margin:8px 0}.challenge-status.error{color:#ffb4b4}
.erro{background:#3a1b1b;border:1px solid #7a3030;color:#ffb4b4;border-radius:9px;
      padding:10px 12px;font-size:13px;margin-bottom:6px}
.rodape{margin-top:20px;font-size:11.5px;color:#5f6b7a}
.ou{display:flex;align-items:center;gap:10px;margin:18px 0 14px;color:#5f6b7a;font-size:11px}
.ou::before,.ou::after{content:"";flex:1;height:1px;background:var(--line)}
.oidc{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;text-decoration:none;background:var(--brand);border:0;cursor:pointer;
      border-radius:10px;padding:14px;color:#fff;font-size:15px;font-weight:700;transition:background .15s}
.oidc:hover{background:var(--brand2)}
/* Transição intro -> formulário: crossfade/slide. O item oculto sai do fluxo
   (absolute) para o visível definir a altura — senão o rodapé ficava longe. */
.auth{position:relative}
.auth>.intro,.auth>.formlogin{transition:opacity .3s ease,transform .32s cubic-bezier(.22,.68,.3,1),visibility 0s linear .32s}
.auth[data-aberto="0"]>.intro,.auth[data-aberto="1"]>.formlogin{opacity:1;visibility:visible;transform:none;transition:opacity .3s ease,transform .32s cubic-bezier(.22,.68,.3,1)}
.auth[data-aberto="1"]>.intro,.auth[data-aberto="0"]>.formlogin{position:absolute;top:0;left:0;right:0;opacity:0;visibility:hidden}
.auth[data-aberto="1"]>.intro{transform:translateX(-14px)}
.auth[data-aberto="0"]>.formlogin{transform:translateX(14px)}
.voltar{margin-top:14px;width:100%;background:transparent;border:0;color:var(--soft);font:inherit;font-size:13px;cursor:pointer;padding:6px}
.voltar:hover{color:var(--ink)}
@media (max-width:860px){
  .split{flex-direction:column}
  .hero{flex:0 0 34vh;min-height:200px}
  .hero img{object-position:50% 42%}
  .painel{flex:1 1 auto;border-left:0;border-top:1px solid var(--line)}
}
</style></head><body>
<div class="split">
  <aside class="hero" aria-hidden="true">
    <img src="/login-hero.jpg" alt="">
    <div class="hero-txt">
      <h2>Imóveis e veículos em leilão. <em>Num só lugar</em></h2>
      <p>Entre para buscar, salvar alertas e acompanhar seus lotes.</p>
    </div>
  </aside>
  <main class="painel">
    <div class="marca"><span class="mk"><i></i></span><b>Radar de Leilões</b></div>
    <div class="auth" data-aberto="__ABERTO__" id="auth">
      <div class="intro">
        <h1>Entrar</h1>
        <p class="sub">Acesse a sua conta do Radar.</p>
        <button type="button" class="oidc" id="abrir">Entrar com conta Radar</button>
      </div>
      <form class="formlogin" method="POST" action="/api/login">
        <h1>Entrar</h1>
        <p class="sub">Use seu usuário e senha da conta Radar.</p>
        <input type="hidden" name="de" value="__DE__">
        __ERRO__
        <label for="usuario">Usuário</label>
        <input id="usuario" name="usuario" autocomplete="username" autocapitalize="none" required>
        <label for="senha">Senha</label>
        <input id="senha" name="senha" type="password" autocomplete="current-password" required>
        <div class="challenge-slot" data-challenge-action="login" aria-live="polite"></div>
        <button type="submit">Entrar</button>
        <button type="button" class="voltar" id="voltar">← Voltar</button>
      </form>
    </div>
    <p class="rodape">Acesso restrito</p>
  </main>
</div>
<script>
(function(){
  var auth=document.getElementById('auth');
  var abre=function(v){auth.dataset.aberto=v?'1':'0';if(v){var u=document.getElementById('usuario');if(u)setTimeout(function(){u.focus()},320)}};
  document.getElementById('abrir').addEventListener('click',function(){abre(true)});
  document.getElementById('voltar').addEventListener('click',function(){abre(false)});
  // Já aberto por erro do POST: foca o campo sem reanimar.
  if(auth.dataset.aberto==='1'){var u=document.getElementById('usuario');if(u)u.focus()}
})();
</script>
<link rel="stylesheet" href="/challenge.css">
<script src="/challenge.js"></script>
<script>
(function(){var form=document.querySelector(".formlogin"),slot=document.querySelector(".challenge-slot"),button=form.querySelector("button[type=submit]"),widget=null,busy=false;function say(text,error){var el=slot.querySelector(".challenge-status");if(!el){el=document.createElement("p");el.className="challenge-status";el.setAttribute("role","status");slot.appendChild(el)}el.textContent=text;el.classList.toggle("error",!!error)}function load(){widget=null;RadarChallenge.prepare(slot,"login").then(function(w){widget=w}).catch(function(){say("Não foi possível preparar a verificação.",true);var retry=document.createElement("button");retry.type="button";retry.className="challenge-retry";retry.textContent="Tentar novamente";retry.onclick=function(){RadarChallenge.retry();retry.remove();load()};slot.appendChild(retry)})}load();form.addEventListener("submit",async function(e){e.preventDefault();if(busy)return;busy=true;button.disabled=true;try{if(!widget)throw new Error("challenge_config");var token=await widget.token();var body=new URLSearchParams(new FormData(form));if(token)body.set("turnstileToken",token);var response=await fetch("/api/login",{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:body.toString(),redirect:"follow"});if(response.redirected){location.assign(response.url);return}if(!response.ok){var data=await response.json().catch(function(){return {}});var retry=Number(data.retryAfterSeconds||response.headers.get("Retry-After"))||3;say(response.status===429?"Muitas tentativas. Aguarde "+retry+" segundos e tente novamente.":data.error==="challenge_unavailable"?"A verificação está temporariamente indisponível. Tente novamente em "+retry+" segundos.":data.error==="challenge_failed"?"A verificação expirou ou não foi concluída. Tente novamente.":"Não foi possível entrar. Confira os dados e tente novamente.",true)}else location.assign(response.url||"/busca")}catch(err){say(err&&err.message==="challenge_unavailable"?"A verificação está temporariamente indisponível. Tente novamente em 3 segundos.":"A verificação expirou ou não carregou. Tente novamente.",true)}finally{if(widget)widget.reset();busy=false;button.disabled=false}})})();
</script></body></html>`;
