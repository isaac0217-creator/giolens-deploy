/**
 * agents/_shared/auth/bearer.ts — comparación constant-time de Bearer token.
 *
 * Cierra P2-2 del Issue #4: el patrón `authStr === \`Bearer ${secret}\`` compara
 * carácter por carácter con short-circuit en el primer mismatch → fuga de timing
 * que en teoría permite recuperar el secret byte a byte. `timingSafeEqual` compara
 * en tiempo constante respecto al contenido.
 *
 * Nota: la guarda de longitud sí revela la longitud esperada del header, pero eso
 * es inevitable (timingSafeEqual lanza si los buffers difieren en tamaño) y de bajo
 * valor para un atacante frente a la fuga byte-a-byte que esto elimina.
 */

import { timingSafeEqual } from 'crypto';

/**
 * @param authHeader valor crudo del header Authorization (ya normalizado a string)
 * @param secret valor de CRON_SECRET
 * @returns true sólo si authHeader === `Bearer ${secret}` en comparación constant-time
 */
export function timingSafeBearer(authHeader: string, secret: string): boolean {
  if (!secret) return false;
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
