/** Casca de linha de comando: a rotina mora em src/core/descoberta.ts e também roda pela fila. */
import { pool } from '../src/core/db.js';
import { rodarDescoberta } from '../src/core/descoberta.js';

console.log(await rodarDescoberta('fenaju'));
await pool.end();
