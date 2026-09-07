/**
 * Validacion de lo que devuelve el modelo.
 *
 * Cinco proveedores distintos con cinco formas de "salida estructurada" es una
 * garantia de que alguno va a mandar algo raro. Todo pasa por aca antes de
 * llegar al juego.
 */

import { z } from 'zod';
import { DIFFICULTIES } from './contracts';

const shortText = (max: number) => z.string().trim().min(1).max(max);

export const questionSchema = z.object({
  prompt: shortText(400),
  answer: shortText(120),
  accept: z.array(z.string().trim().min(1).max(120)).max(12).default([]),
  topic: z.string().trim().max(60).default('general'),
  difficulty: z.enum(DIFFICULTIES as [string, ...string[]]).default('normal'),
  note: z.string().trim().max(240).optional(),
});

export const generateResultSchema = z.object({
  questions: z.array(questionSchema).min(1).max(20),
});

export const verifyResultSchema = z.object({
  revisadas: z
    .array(
      z.object({
        n: z.number().int().min(1).max(50),
        sirve: z.boolean(),
        motivo: z.string().trim().max(200).optional(),
      }),
    )
    .max(50),
});

export const judgeResultSchema = z.object({
  verdict: z.enum(['correcta', 'parcial', 'incorrecta']),
  reason: z.string().trim().max(160).default(''),
});

/**
 * Algunos modelos devuelven el JSON envuelto en ```json ... ``` o con texto
 * alrededor pese a pedirles lo contrario. Rescatamos el primer objeto balanceado.
 */
export function extractJson(raw: string): unknown {
  const text = raw.trim();
  try {
    return JSON.parse(text);
  } catch {
    // seguimos abajo
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // seguimos abajo
    }
  }

  const start = text.indexOf('{');
  if (start === -1) throw new Error('La respuesta del modelo no traía JSON.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('La respuesta del modelo traía un JSON incompleto.');
}
