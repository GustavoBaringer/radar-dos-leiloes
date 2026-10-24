(() => {
  const button = document.getElementById('continuar');
  const status = document.getElementById('estado');
  let token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  const validToken = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);

  // Fragmento removido do histórico e de qualquer elemento; manter só em memória.
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  if (!validToken) {
    token = null;
    status.textContent = 'Abra o link enviado por e-mail para continuar.';
    return;
  }

  status.textContent = 'Convite pronto. Selecione “Continuar cadastro” para confirmar.';
  button.disabled = false;
  let pending = false;
  button.addEventListener('click', async () => {
    if (pending || !token) return;
    pending = true;
    button.disabled = true;
    status.removeAttribute('data-tipo');
    status.textContent = 'Enviando sua solicitação…';
    try {
      const response = await fetch('/api/onboarding/invitations/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error('request failed');
      status.textContent = 'Solicitação recebida. Se o convite for válido, você receberá os próximos passos por e-mail.';
      status.dataset.tipo = 'sucesso';
      token = null;
    } catch {
      status.textContent = 'Não foi possível enviar agora. Tente novamente.';
      pending = false;
      button.disabled = false;
    }
  });
})();
