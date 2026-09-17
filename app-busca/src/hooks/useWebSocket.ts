import { useEffect, useRef, useState } from 'react';
import type { WsMessage } from '@/lib/types';

/** Sem tráfego nesta janela, o socket é dado como caído mesmo "aberto". */
const SILENCIO_MAX_MS = 90_000;
const CHECA_MS = 15_000;
const RECONECTA_MS = 4_000;

/**
 * Conexão ao vivo com o worker: lance novo, coleta e encerramento chegam por
 * aqui e a tela muda sem recarregar.
 *
 * O heartbeat existe porque socket meio-aberto (rede caiu sem FIN) mantinha o
 * indicador verde indefinidamente — o navegador não dispara `onclose`, e a
 * única evidência de que a conexão morreu é a ausência de mensagem.
 *
 * `aoReceber` fica em ref para a conexão não ser derrubada e refeita a cada
 * render do componente que a usa.
 */
export function useWebSocket(aoReceber: ((msg: WsMessage) => void) | null) {
  const [aoVivo, setAoVivo] = useState(false);
  const handler = useRef(aoReceber);
  handler.current = aoReceber;

  useEffect(() => {
    // `null` = não conectar. O /ws exige sessão, e um visitante anônimo ficaria
    // num laço de 401 + reconexão a cada 4 segundos.
    if (!handler.current) return;
    let ws: WebSocket | null = null;
    let hb: ReturnType<typeof setInterval> | undefined;
    let religar: ReturnType<typeof setTimeout> | undefined;
    let vivo = true;
    let ultimaMsg = Date.now();

    function conectar() {
      if (!vivo) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);

      ws.onopen = () => {
        setAoVivo(true);
        ultimaMsg = Date.now();
        clearInterval(hb);
        hb = setInterval(() => {
          if (Date.now() - ultimaMsg > SILENCIO_MAX_MS) {
            setAoVivo(false);
            try {
              ws?.close();
            } catch {
              /* fechar socket já morto não é erro */
            }
          }
        }, CHECA_MS);
      };

      ws.onmessage = (ev) => {
        ultimaMsg = Date.now();
        try {
          handler.current?.(JSON.parse(ev.data) as WsMessage);
        } catch {
          /* mensagem malformada não pode derrubar a tela */
        }
      };

      ws.onclose = () => {
        clearInterval(hb);
        setAoVivo(false);
        if (vivo) religar = setTimeout(conectar, RECONECTA_MS);
      };

      ws.onerror = () => {
        /* o onclose seguinte cuida da religação */
      };
    }

    conectar();
    return () => {
      vivo = false;
      clearInterval(hb);
      clearTimeout(religar);
      try {
        ws?.close();
      } catch {
        /* idem */
      }
    };
  }, []);

  return aoVivo;
}
