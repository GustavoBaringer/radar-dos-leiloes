/* Shared, explicit Turnstile adapter. SDK and config are never requested in off mode. */
(function (root) {
  'use strict';
  var configPromise;
  var sdkPromise;
  function config() {
    if (!configPromise) configPromise = fetch('/api/security-config', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('challenge_config');
      return r.json();
    }).then(function (c) {
      if (typeof c.enabled !== 'boolean' || !Array.isArray(c.actions)) throw new Error('challenge_config');
      return c;
    });
    return configPromise;
  }
  function sdk() {
    if (root.turnstile) return Promise.resolve(root.turnstile);
    if (!sdkPromise) sdkPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true; script.defer = true;
      script.onload = function () { root.turnstile ? resolve(root.turnstile) : reject(new Error('challenge_sdk')); };
      script.onerror = function () { reject(new Error('challenge_sdk')); };
      document.head.appendChild(script);
    });
    return sdkPromise;
  }
  async function prepare(container, action) {
    var cfg = await config();
    if (!cfg.actions.includes(action)) throw new Error('challenge_config');
    if (!cfg.enabled) return { token: async function () { return ''; }, reset: function () {}, destroy: function () {} };
    if (!cfg.siteKey) throw new Error('challenge_config');
    var ts = await sdk();
    var tokenValue = null, resolver = null, rejecter = null, widgetId = null, dead = false;
    function fail() { if (rejecter) { rejecter(new Error('challenge_unavailable')); resolver = rejecter = null; } }
    widgetId = ts.render(container, {
      sitekey: cfg.siteKey, action: action, execution: 'execute',
      callback: function (token) { tokenValue = token; if (resolver) { resolver(token); resolver = rejecter = null; } },
      'expired-callback': function () { tokenValue = null; fail(); },
      'timeout-callback': fail,
      'error-callback': fail
    });
    function cleanup() {
      dead = true; tokenValue = null;
      if (resolver) { rejecter(new Error('challenge_unavailable')); resolver = rejecter = null; }
      ts.remove(widgetId);
      root.removeEventListener('pagehide', cleanup);
    }
    root.addEventListener('pagehide', cleanup, { once: true });
    return {
      token: function () {
        if (dead) return Promise.reject(new Error('challenge_unavailable'));
        if (tokenValue) return Promise.resolve(tokenValue);
        return new Promise(function (resolve, reject) {
          resolver = resolve; rejecter = reject;
          try { ts.execute(widgetId); } catch (_) { rejecter(new Error('challenge_unavailable')); resolver = rejecter = null; }
        });
      },
      reset: function () { tokenValue = null; if (resolver) { rejecter(new Error('challenge_unavailable')); resolver = rejecter = null; } ts.reset(widgetId); },
      destroy: cleanup
    };
  }
  root.RadarChallenge = { prepare: prepare, retry: function () { configPromise = sdkPromise = null; } };
})(window);
