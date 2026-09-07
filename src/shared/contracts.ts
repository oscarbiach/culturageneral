/**
 * Contrato entre la app y el proxy de IA.
 *
 * Vive en `shared/` porque lo importan los dos lados: el cliente (src/ai) y el
 * Cloudflare Worker (worker/src). Cualquier cambio aca es un cambio de protocolo:
 * si desplegas una version nueva de la app, redesplega tambien el Worker.
 */

export const PROTOCOL_VERSION = 1;

/** Escala de dificultad tal como la entiende el generador. */
export type Difficulty = 'facil' | 'normal' | 'dificil' | 'brutal';

export const DIFFICULTIES: Difficulty[] = ['facil', 'normal', 'dificil', 'brutal'];

export interface GeneratedQuestion {
  /** Enunciado, listo para leerse en voz alta. */
  prompt: string;
  /** Respuesta canonica, lo mas corta posible. */
  answer: string;
  /** Otras formas de decir lo mismo que tambien valen. */
  accept: string[];
  /** Subtema, para mostrar como etiqueta y para que el pedido no se desbalancee. */
  topic: string;
  difficulty: Difficulty;
  /** Dato de color opcional que se muestra al revelar la respuesta. */
  note?: string;
}

export interface GenerateParams {
  /** El pedido en lenguaje natural. Es lo mas importante del request. */
  brief: string;
  count: number;
  difficulty: Difficulty;
  /** Enunciados ya usados en la partida, para no repetir. */
  avoid: string[];
  /** Correcciones que la mesa fue pidiendo, en orden cronologico. */
  feedback: string[];
}

export interface GenerateResult {
  questions: GeneratedQuestion[];
}

export type Verdict = 'correcta' | 'parcial' | 'incorrecta';

export interface JudgeParams {
  question: string;
  answer: string;
  accept: string[];
  /** Lo que dijo o escribio el jugador. */
  given: string;
}

export interface JudgeResult {
  verdict: Verdict;
  /** Explicacion muy breve para mostrar en pantalla. */
  reason: string;
}

/** Proveedores soportados. Los tres ultimos hablan el dialecto de OpenAI. */
export type ProviderId = 'anthropic' | 'gemini' | 'openai' | 'groq' | 'openrouter';

export interface AiRequest {
  v: typeof PROTOCOL_VERSION;
  task: 'generate' | 'judge';
  params: GenerateParams | JudgeParams;
  /**
   * Proveedor y modelo pedidos. El proxy puede ignorarlos y usar los suyos:
   * quien pone la key manda.
   */
  provider?: ProviderId;
  model?: string;
}

export interface AiErrorBody {
  error: string;
  /** Codigo estable para que la UI decida que mensaje mostrar. */
  code:
    | 'bad_request'
    | 'unauthorized'
    | 'rate_limited'
    | 'overloaded'
    | 'provider_error'
    | 'refusal'
    | 'bad_output'
    | 'not_configured';
}

/** Topes duros. El Worker los revalida: nunca confies en el cliente. */
export const LIMITS = {
  briefChars: 600,
  feedbackChars: 300,
  feedbackItems: 12,
  avoidItems: 120,
  avoidChars: 200,
  minCount: 1,
  maxCount: 15,
  givenChars: 300,
} as const;

/** Recorta y normaliza params del cliente. Se corre en los dos lados. */
export function clampGenerateParams(raw: Partial<GenerateParams>): GenerateParams {
  const cut = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
  return {
    brief: cut(raw.brief, LIMITS.briefChars),
    count: Math.min(
      LIMITS.maxCount,
      Math.max(LIMITS.minCount, Math.round(Number(raw.count) || 8)),
    ),
    difficulty: DIFFICULTIES.includes(raw.difficulty as Difficulty)
      ? (raw.difficulty as Difficulty)
      : 'normal',
    // Nos quedamos con las ultimas: son las que el modelo mas necesita ver.
    avoid: (Array.isArray(raw.avoid) ? raw.avoid : [])
      .slice(-LIMITS.avoidItems)
      .map((s) => cut(s, LIMITS.avoidChars))
      .filter(Boolean),
    feedback: (Array.isArray(raw.feedback) ? raw.feedback : [])
      .slice(-LIMITS.feedbackItems)
      .map((s) => cut(s, LIMITS.feedbackChars))
      .filter(Boolean),
  };
}

export function clampJudgeParams(raw: Partial<JudgeParams>): JudgeParams {
  const cut = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
  return {
    question: cut(raw.question, LIMITS.briefChars),
    answer: cut(raw.answer, LIMITS.avoidChars),
    accept: (Array.isArray(raw.accept) ? raw.accept : [])
      .slice(0, 12)
      .map((s) => cut(s, LIMITS.avoidChars))
      .filter(Boolean),
    given: cut(raw.given, LIMITS.givenChars),
  };
}
