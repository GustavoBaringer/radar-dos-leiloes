/** Browser requests share the proxy's two processing slots. */
export function createImageQueue(limit = 2) {
  const pending: Array<{ begin: (release: () => void) => void; cancelled: boolean; release?: () => void }> = [];
  let active = 0;
  function pump() {
    while (active < limit && pending.length) {
      const ticket = pending.shift()!;
      if (ticket.cancelled) continue;
      active++;
      let released = false;
      ticket.release = () => {
        if (released) return;
        released = true;
        active--;
        pump();
      };
      ticket.begin(ticket.release);
    }
  }
  return {
    enqueue(begin: (release: () => void) => void) {
      const ticket = { begin, cancelled: false, release: undefined as (() => void) | undefined };
      pending.push(ticket);
      pump();
      return () => {
        ticket.cancelled = true;
        const index = pending.indexOf(ticket);
        if (index >= 0) pending.splice(index, 1);
        ticket.release?.();
      };
    },
  };
}
export const cardImageQueue = createImageQueue();
