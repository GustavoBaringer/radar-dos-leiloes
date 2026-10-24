(() => {
  const button = document.getElementById('continuar');
  const status = document.getElementById('estado');
  let token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  const validToken = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

  // Remove the secret fragment from the address bar/history before any request.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  if (!validToken) {
    token = null;
    status.textContent = 'Link indisponível. Abra o link recebido para continuar.';
    return;
  }

  status.textContent = 'Link pronto. Continue para vincular a assinatura à sua conta.';
  button.disabled = false;
  let pending = false;
  button.addEventListener('click', async () => {
    if (pending || !token) return;
    pending = true;
    button.disabled = true;
    status.removeAttribute('data-tipo');
    status.textContent = 'Preparando a autenticação…';
    try {
      const response = await fetch('/api/onboarding/activation/start', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error('request failed');
      const data = await response.json();
      if (typeof data.authorizationUrl !== 'string') throw new Error('invalid response');
      const destination = new URL(data.authorizationUrl);
      const localHttp = destination.protocol === 'http:' &&
        (destination.hostname === 'localhost' || destination.hostname === '127.0.0.1' || destination.hostname === '[::1]');
      if ((destination.protocol !== 'https:' && !localHttp) || destination.username || destination.password || destination.hash) {
        throw new Error('invalid destination');
      }
      token = null;
      window.location.assign(destination.href);
    } catch {
      status.dataset.tipo = 'erro';
      status.textContent = 'Não foi possível iniciar a autenticação. Tente novamente ou abra um novo link recebido.';
      pending = false;
      button.disabled = false;
    }
  });
})();
