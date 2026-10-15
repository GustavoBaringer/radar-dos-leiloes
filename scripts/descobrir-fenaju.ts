/** Casca de linha de comando: rotina e worker compartilham DiscoveryService. */
import { createDiscoveryContext } from '../src/bootstrap/discovery-context.js';

const context = await createDiscoveryContext();
try { console.log(await context.service.rodarDescoberta('fenaju')); }
finally { await context.close(); }
