type DestroyableSocket = {
  destroy(): unknown;
  once(event: 'close', listener: () => void): unknown;
};

type CloseAction = () => void | Promise<void>;

export function createBootstrapLifecycle(reportError: (error: unknown) => void = console.error) {
  let closeHttp: CloseAction | undefined;
  let closeTls: CloseAction | undefined;
  let closing: Promise<void> | undefined;
  const sockets = new Set<DestroyableSocket>();

  const lifecycle = {
    setHttpClose(close: CloseAction) { closeHttp = close; },
    setTlsClose(close: CloseAction) { closeTls = close; },
    trackSocket(socket: DestroyableSocket) {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    },
    close(): Promise<void> {
      if (closing) return closing;
      closing = (async () => {
        const failures: unknown[] = [];
        const pending: Promise<void>[] = [];
        const start = (action: CloseAction) => {
          try { pending.push(Promise.resolve(action())); }
          catch (error) { failures.push(error); }
        };

        if (closeTls) start(closeTls);
        for (const socket of sockets) {
          try { socket.destroy(); }
          catch (error) { failures.push(error); }
        }
        if (closeHttp) start(closeHttp);

        for (const result of await Promise.allSettled(pending)) {
          if (result.status === 'rejected') failures.push(result.reason);
        }
        if (failures.length) throw new AggregateError(failures, 'Bootstrap cleanup failed');
      })();
      return closing;
    },
    async failStartup(startupError: unknown): Promise<never> {
      try { await lifecycle.close(); }
      catch (cleanupError) {
        throw new AggregateError([startupError, cleanupError], 'Bootstrap startup and cleanup failed');
      }
      throw startupError;
    },
    reportCleanupFailure(error: unknown) {
      reportError(error);
    },
  };
  return lifecycle;
}
