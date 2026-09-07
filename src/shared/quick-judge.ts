/**
 * Arbitro local: resuelve al instante los casos que no necesitan a nadie.
 *
 * La mayoria de las respuestas de una trivia son exactas o casi: "messi" contra
 * "Lionel Messi", "dibu" contra una variante aceptada, o directamente un "paso".
 * Mandar eso a un modelo cuesta segundos de espera con el telefono en la mesa y
 * la mesa mirando, y no aporta nada.
 *
 * La regla es que ante la menor duda devuelve null y decide la IA. Preferimos
 * consultar de mas antes que cantar un punto que no era.
 */

import type { JudgeParams, JudgeResult } from './contracts';

/** Minusculas, sin tildes y sin puntuacion: como suena, no como se escribe. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ademas saca los articulos del principio: "el diego" y "diego" son lo mismo. */
function core(text: string): string {
  return normalize(text).replace(/^(?:(?:el|la|los|las|un|una|unos|unas)\s+)+/, '');
}

/** Formas de rendirse. Ninguna necesita que un modelo opine. */
const GIVE_UP = new Set([
  'no se',
  'no lo se',
  'no la se',
  'ni idea',
  'ni idea ninguna',
  'paso',
  'nada',
  'ns',
  'no',
  'nose',
]);

/** Con menos letras que esto, buscar la respuesta adentro de la frase da falsos positivos. */
const MIN_SUBSTRING = 4;
/** Un apellido suelto vale si es distintivo; "juan" o "cruz" no lo son. */
const MIN_SURNAME = 5;

/**
 * Distancia de edicion, cortada apenas se pasa del limite.
 *
 * Sirve para los errores de tipeo y de dictado, que en una mesa son la norma:
 * nadie escribe "Emiliano Martínez" completo y sin equivocarse mientras el otro
 * lo apura.
 */
function withinDistance(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  if (a === b) return true;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      best = Math.min(best, current[j]);
    }
    // Si la fila entera ya se paso del limite, no hay vuelta atras.
    if (best > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

/** Cuanto error de tipeo se le perdona a una respuesta segun lo larga que sea. */
function tolerance(text: string): number {
  if (text.length <= 4) return 0;
  if (text.length <= 8) return 1;
  if (text.length <= 14) return 2;
  return 3;
}

/** Devuelve un veredicto solo si es indiscutible; si no, null y decide la IA. */
export function quickJudge(params: JudgeParams): JudgeResult | null {
  const given = core(params.given);

  if (!given || GIVE_UP.has(given)) {
    return { verdict: 'incorrecta', reason: 'No contestó' };
  }

  const candidates = [params.answer, ...params.accept].map(core).filter(Boolean);
  if (!candidates.length) return null;

  // Dijo exactamente la respuesta, o una de las variantes aceptadas.
  if (candidates.includes(given)) {
    return { verdict: 'correcta', reason: 'Es la respuesta' };
  }

  // O la escribio con un error de tipeo o de dictado: "emiliano martines".
  for (const candidate of candidates) {
    if (withinDistance(given, candidate, tolerance(candidate))) {
      return { verdict: 'correcta', reason: 'Es la respuesta' };
    }
  }

  // O la dijo entre otras palabras: "creo que fue emiliano martinez".
  // Los espacios de los bordes evitan que "oro" matchee dentro de "toronto".
  const haystack = ` ${given} `;
  for (const candidate of candidates) {
    if (candidate.length < MIN_SUBSTRING) continue;
    if (haystack.includes(` ${candidate} `)) {
      return { verdict: 'correcta', reason: 'Dijo la respuesta' };
    }
  }

  // O dijo solo el apellido, que en una mesa es lo normal. Pedimos que sea
  // largo y unico para no regalar puntos con un "juan" o un "cruz".
  const surnames = candidates
    .map((candidate) => candidate.split(' '))
    .filter((parts) => parts.length > 1)
    .map((parts) => parts[parts.length - 1])
    .filter((surname) => surname.length >= MIN_SURNAME);

  for (const surname of surnames) {
    if (given === surname || withinDistance(given, surname, tolerance(surname))) {
      return { verdict: 'correcta', reason: 'Con el apellido alcanza' };
    }
  }

  // Todo lo demas —sinonimos, numeros escritos con letras, respuestas a medias,
  // errores de dictado— lo decide la IA, que para eso esta.
  return null;
}
