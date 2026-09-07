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

  // O la dijo entre otras palabras: "creo que fue emiliano martinez".
  // Los espacios de los bordes evitan que "oro" matchee dentro de "toronto".
  const haystack = ` ${given} `;
  for (const candidate of candidates) {
    if (candidate.length < MIN_SUBSTRING) continue;
    if (haystack.includes(` ${candidate} `)) {
      return { verdict: 'correcta', reason: 'Dijo la respuesta' };
    }
  }

  // Todo lo demas —sinonimos, numeros escritos con letras, respuestas a medias,
  // errores de dictado— lo decide la IA, que para eso esta.
  return null;
}
