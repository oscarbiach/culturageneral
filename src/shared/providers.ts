/**
 * Una sola funcion para hablar con cualquiera de los proveedores.
 *
 * La usan los dos caminos: el Cloudflare Worker (con la key del duenio) y el
 * navegador en modo avanzado (con la key que cada uno pega en Ajustes). Que sea
 * el mismo codigo es lo que garantiza que las preguntas salgan iguales por los
 * dos lados.
 */

import {
  clampGenerateParams,
  clampJudgeParams,
  type GenerateParams,
  type GenerateResult,
  type JudgeParams,
  type JudgeResult,
  type ProviderId,
} from './contracts';
import {
  GENERATE_SYSTEM_PROMPT,
  JUDGE_SYSTEM_PROMPT,
  VERIFY_SYSTEM_PROMPT,
  buildGenerateUserPrompt,
  buildJudgeUserPrompt,
  buildVerifyUserPrompt,
  generateSchema,
  judgeSchema,
  verifySchema,
} from './prompts';
import {
  extractJson,
  generateResultSchema,
  judgeResultSchema,
  verifyResultSchema,
} from './schemas';

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
  /**
   * Se llama cuando hubo que cambiar de modelo porque el elegido estaba
   * saturado. Quien lo reciba deberia guardarlo: la proxima partida arranca por
   * el que anduvo y no vuelve a chocar contra la misma pared.
   */
  onModelSwitch?: (model: string) => void;
}

export interface ProviderMeta {
  id: ProviderId;
  label: string;
  /** Modelo por defecto. Puede quedar viejo: la UI deja cargar la lista real. */
  defaultModel: string;
  /** Donde se saca la key. */
  keysUrl: string;
  hint: string;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    id: 'gemini',
    label: 'Google Gemini',
    // A proposito NO el mas nuevo: los recien lanzados son los que se saturan,
    // sobre todo en la capa gratuita, durante las primeras semanas. Si este no
    // existiera, la busqueda de hermanos encuentra uno vivo y lo recuerda.
    defaultModel: 'gemini-2.5-flash',
    keysUrl: 'https://aistudio.google.com/apikey',
    hint: 'Tiene capa gratuita. Es el más fácil para arrancar.',
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-opus-5',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    hint: 'El que mejor obedece pedidos con matices tipo «menos capitales».',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-5.6',
    keysUrl: 'https://platform.openai.com/api-keys',
    hint: 'Requiere créditos cargados.',
  },
  {
    id: 'groq',
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    keysUrl: 'https://console.groq.com/keys',
    hint: 'Muy rápido y con capa gratuita, aunque las preguntas salen más planas.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'google/gemini-3.8-flash',
    keysUrl: 'https://openrouter.ai/keys',
    hint: 'Una sola key para decenas de modelos, algunos gratis.',
  },
];

export function providerMeta(id: ProviderId): ProviderMeta {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Error con un codigo estable para que la UI elija el mensaje. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unauthorized'
      | 'rate_limited'
      | 'overloaded'
      | 'model_missing'
      | 'timeout'
      | 'provider_error'
      | 'refusal'
      | 'bad_output'
      | 'not_configured',
    /**
     * Si esto se arregla solo esperando un momento. Va aparte del codigo a
     * proposito: un 503 se reintenta y un 400 no, y los dos podrian caer bajo
     * el mismo codigo si nos guiaramos solo por ahi.
     */
    readonly retryable = false,
    /** Cuanto pidio esperar el proveedor, si lo dijo. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

const OPENAI_COMPATIBLE: Partial<Record<ProviderId, string>> = {
  openai: 'https://api.openai.com/v1',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};

/** Tapa cualquier cosa con pinta de API key antes de que llegue a la pantalla. */
function redactKeys(text: string): string {
  return text
    .replace(/\b(sk|gsk|sk-or|xai)[-_][A-Za-z0-9_-]{8,}/gi, '***')
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, '***');
}

/** Los que se van solos si esperás un poco. 529 es el "overloaded" de Anthropic. */
const TRANSIENT = new Set([408, 500, 502, 503, 504, 529]);

function httpError(status: number, body: string): AiError {
  const detail = redactKeys(body.slice(0, 300));
  if (status === 401 || status === 403) {
    return new AiError(`El proveedor rechazó la API key (${status}). ${detail}`, 'unauthorized');
  }
  if (status === 429) {
    // Google y compania suelen decir cuanto falta. Lo usamos para avisar, no
    // para reintentar: esperar medio minuto con la pantalla de carga puesta, y
    // encima fallar igual, es peor que decir la verdad y ofrecer el boton.
    const seconds = Number(detail.match(/retryDelay["\s:]+(\d+)/)?.[1]);
    const wait = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 90) : 0;
    return new AiError(
      wait
        ? `Llegaste al cupo por minuto de la capa gratuita. Esperá ${wait} segundos y reintentá.`
        : 'Llegaste al cupo por minuto de la capa gratuita. Esperá un minuto y reintentá.',
      'rate_limited',
      false,
      wait ? wait * 1000 : undefined,
    );
  }
  if (status === 404) {
    return new AiError(
      'Ese modelo no existe o tu key no lo tiene habilitado.',
      'model_missing',
    );
  }
  if (TRANSIENT.has(status)) {
    // El cuerpo crudo del proveedor no le dice nada a nadie en una juntada.
    return new AiError(
      'El modelo está saturado en este momento. Probá de nuevo en un rato, o cambiá de modelo en Ajustes: los recién salidos son los que más se saturan.',
      'overloaded',
      true,
    );
  }
  return new AiError(`El proveedor respondió ${status}. ${detail}`, 'provider_error');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Techos de tiempo por tarea, en milisegundos. */
const TIMEOUTS = {
  /** Generar pasa en la pantalla de carga: se le da aire. */
  generate: 60_000,
  verify: 45_000,
  /** Juzgar tiene a la mesa esperando. Pasado esto, deciden ellos. */
  judge: 9_000,
} as const;
const LIST_TIMEOUT_MS = 10_000;

/** fetch con techo de tiempo, y con los fallos traducidos a algo explicable. */
async function request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      // No es reintentable: si tardo de mas una vez, va a volver a tardar, y
      // mientras tanto la mesa espera.
      throw new AiError('El proveedor tardó demasiado en contestar.', 'timeout');
    }
    if ((error as Error)?.name === 'AbortError') throw error;
    throw new AiError(
      'No se pudo conectar con el proveedor. Fijate la conexión.',
      'provider_error',
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reintenta lo que se arregla solo: saturación del modelo y cortes de red.
 *
 * Que el jugador tenga que tocar "reintentar" tres veces en medio de una
 * partida no es una opción, y una espera de dos segundos no se nota cuando la
 * alternativa es que se corte el juego.
 */
async function withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const worthRetrying = error instanceof AiError && error.retryable;
      if (!worthRetrying || attempt >= attempts - 1) throw error;
      // Si el proveedor dijo cuanto esperar, se le hace caso; si no, espera
      // creciente con un pellizco de azar para no reintentar todos a la vez.
      const wait = error.retryAfterMs ?? 700 * 2 ** attempt + Math.random() * 400;
      await sleep(wait);
    }
  }
}

/**
 * Gemini acepta un subconjunto de JSON Schema y se enoja con `additionalProperties`.
 */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (key === 'additionalProperties') continue;
      out[key] = toGeminiSchema(value);
    }
    return out;
  }
  return schema;
}

interface Call {
  system: string;
  user: string;
  schema: unknown;
  schemaName: string;
  /** Cuanto pensar. Juzgar una respuesta es barato; inventar preguntas no. */
  effort: 'low' | 'high';
  /**
   * Techo duro por llamada. Sin esto una peticion colgada se lleva puesta la
   * partida: nadie va a esperar con el telefono en la mano.
   */
  timeoutMs: number;
  /** Intentos totales ante un error pasajero. 1 = no reintentar. */
  retries: number;
  /**
   * Si vale la pena probar otro modelo cuando este falla. Para generar si:
   * pasa en la pantalla de carga. Para juzgar no: hay alguien esperando, y
   * encadenar modelos convierte una espera larga en uno eterna.
   */
  allowModelSwitch: boolean;
  /**
   * Cero para las tareas donde solo hay una respuesta correcta. Solo generar
   * necesita algo de azar, y aun asi poco: cuanto mas alta, mas se inventa.
   */
  temperature: number;
  maxTokens: number;
}

/**
 * Modelos que rechazaron el ajuste de "pensar". No todas las generaciones de
 * Gemini aceptan el mismo campo, y no queremos pagar un viaje extra por cada
 * respuesta: se aprende una vez por sesion.
 */
const noThinkingConfig = new Set<string>();

async function callAnthropic(cfg: ProviderConfig, call: Call): Promise<unknown> {
  // El SDK oficial se carga en demanda: en el telefono no queremos pagar el peso
  // del bundle si el jugador usa otro proveedor.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    // Necesario cuando la app llama directo desde el navegador con la key del
    // propio jugador. En el Worker no cambia nada.
    dangerouslyAllowBrowser: true,
    timeout: call.timeoutMs,
    // Los reintentos los maneja `withRetry`, que sabe cual es la tarea: el SDK
    // reintentando por su cuenta multiplicaria la espera del arbitro.
    maxRetries: 0,
  });

  try {
    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: call.maxTokens,
      system: call.system,
      messages: [{ role: 'user', content: call.user }],
      output_config: {
        effort: call.effort === 'high' ? 'medium' : 'low',
        format: {
          type: 'json_schema',
          schema: call.schema as Record<string, unknown>,
        },
      },
    });

    if (response.stop_reason === 'refusal') {
      throw new AiError(
        'Claude no quiso generar eso. Probá reformulando el pedido de la mesa.',
        'refusal',
      );
    }

    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    return extractJson(text);
  } catch (error) {
    if (error instanceof AiError) throw error;
    const status = (error as { status?: number }).status;
    if (typeof status === 'number') throw httpError(status, String((error as Error).message ?? ''));
    throw error;
  }
}

async function callGemini(cfg: ProviderConfig, call: Call): Promise<unknown> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    cfg.model,
  )}:generateContent`;

  const body = (withThinking: boolean) => ({
    systemInstruction: { parts: [{ text: call.system }] },
    contents: [{ role: 'user', parts: [{ text: call.user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: toGeminiSchema(call.schema),
      maxOutputTokens: call.maxTokens,
      temperature: call.temperature,
      // Juzgar una respuesta no necesita que el modelo razone largo, y esos
      // segundos se sienten con el telefono en el medio de la mesa.
      ...(withThinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
    },
  });

  const send = (withThinking: boolean) =>
    request(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
        body: JSON.stringify(body(withThinking)),
      },
      call.timeoutMs,
    );

  const tune = call.effort === 'low' && !noThinkingConfig.has(cfg.model);
  let response = await send(tune);

  // Las generaciones viejas de Gemini no conocen ese campo. Lo anotamos para no
  // volver a pagar el viaje de mas en el resto de la partida.
  if (tune && response.status === 400) {
    const detail = await response.text();
    if (/thinking/i.test(detail)) {
      noThinkingConfig.add(cfg.model);
      response = await send(false);
    } else {
      throw httpError(400, detail);
    }
  }

  if (!response.ok) throw httpError(response.status, await response.text());
  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  if (data.promptFeedback?.blockReason) {
    throw new AiError(
      `Gemini bloqueó el pedido (${data.promptFeedback.blockReason}). Probá reformularlo.`,
      'refusal',
    );
  }
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  if (!text) throw new AiError('Gemini devolvió una respuesta vacía.', 'bad_output');
  return extractJson(text);
}

async function callOpenAiCompatible(cfg: ProviderConfig, call: Call): Promise<unknown> {
  const base = OPENAI_COMPATIBLE[cfg.provider];
  if (!base) throw new AiError(`Proveedor desconocido: ${cfg.provider}.`, 'not_configured');

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: call.user },
    ],
    max_completion_tokens: call.maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: call.schemaName, strict: true, schema: call.schema },
    },
  };

  const send = async (payload: Record<string, unknown>) =>
    request(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
          // OpenRouter los pide para atribuir el trafico; el resto los ignora.
          'http-referer': 'https://github.com/oscarbiach/culturageneral',
          'x-title': 'Mano a Mano',
        },
        body: JSON.stringify(payload),
      },
      call.timeoutMs,
    );

  let response = await send(body);

  // No todos los modelos de Groq y OpenRouter aceptan json_schema estricto.
  // Si el 400 viene por ahi, reintentamos con el modo JSON generico.
  if (response.status === 400) {
    const detail = await response.text();
    if (/response_format|json_schema|schema/i.test(detail)) {
      response = await send({ ...body, response_format: { type: 'json_object' } });
    } else {
      throw httpError(400, detail);
    }
  }

  if (!response.ok) throw httpError(response.status, await response.text());
  const data = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const text = data.choices?.[0]?.message?.content ?? '';
  if (!text) throw new AiError('El proveedor devolvió una respuesta vacía.', 'bad_output');
  return extractJson(text);
}

/**
 * Descompone el nombre de un modelo en "de que familia es" y "que version es".
 *
 *   gemini-3.8-flash        -> { words: 'gemini-flash', version: 3.8 }
 *   google/gemini-3.7-flash -> { words: 'gemini-flash', version: 3.7 }
 *   claude-opus-4-8         -> { words: 'claude-opus',  version: 4 }
 *
 * Sirve para encontrar el pariente mas cercano de un modelo saturado sin tener
 * ninguna lista escrita a mano, que es lo que se pudre con cada lanzamiento.
 */
export function modelShape(id: string): { words: string; version: number } {
  const bare = id.includes('/') ? (id.split('/').pop() ?? id) : id;
  const tokens = bare.toLowerCase().split(/[-_]/).filter(Boolean);
  const numeric = tokens.filter((t) => /^\d/.test(t));
  const words = tokens.filter((t) => !/^\d/.test(t));
  return {
    words: words.join('-'),
    version: numeric.length ? Number.parseFloat(numeric[0]) || 0 : 0,
  };
}

/** La lista de modelos por key es estable durante una partida; no la pedimos dos veces. */
const modelListCache = new Map<string, string[]>();

/** Vacía la caché de listas de modelos. Existe para que los tests no se pisen. */
export function resetModelCache(): void {
  modelListCache.clear();
}

/**
 * Hermanos del modelo pedido, del mas nuevo al mas viejo.
 *
 * Salen de la lista que devuelve el propio proveedor, no de una constante en el
 * codigo: asi la app sigue encontrando alternativas meses despues, sin que nadie
 * la actualice.
 */
async function siblingModels(cfg: ProviderConfig, tried: Set<string>): Promise<string[]> {
  const cacheKey = `${cfg.provider}:${cfg.apiKey.slice(-8)}`;
  let listing = modelListCache.get(cacheKey);
  if (!listing) {
    // Un listado fallido NO se cachea: si se cae una vez por un corte de red,
    // guardarlo dejaria a la app sin alternativas por el resto de la sesión,
    // que es justo cuando mas las necesita.
    listing = await listModels(cfg).catch(() => [] as string[]);
    if (listing.length) modelListCache.set(cacheKey, listing);
  }

  const wanted = modelShape(cfg.model);
  const family = listing.filter(
    (id) => !tried.has(id) && modelShape(id).words === wanted.words,
  );

  // Bajar de generacion primero, empezando por la mas cercana. Subir al mas
  // nuevo seria correr hacia el que justamente esta saturado.
  const older = family
    .filter((id) => modelShape(id).version < wanted.version)
    .sort((a, b) => modelShape(b).version - modelShape(a).version);
  const newer = family
    .filter((id) => modelShape(id).version >= wanted.version)
    .sort((a, b) => modelShape(a).version - modelShape(b).version);

  return [...older, ...newer].slice(0, 3);
}

/**
 * Cambiar de modelo solo sirve si el problema es del modelo. Una key rechazada o
 * una cuota agotada fallan igual en todos, y probar cuatro seria hacer esperar
 * al jugador cuatro veces para nada.
 */
function worthSwitching(error: unknown): boolean {
  return error instanceof AiError && (error.code === 'overloaded' || error.code === 'model_missing');
}

function callOne(cfg: ProviderConfig, call: Call): Promise<unknown> {
  if (cfg.provider === 'anthropic') return callAnthropic(cfg, call);
  if (cfg.provider === 'gemini') return callGemini(cfg, call);
  return callOpenAiCompatible(cfg, call);
}

/**
 * Devuelve tambien con que modelo salio, para que la siguiente llamada de la
 * misma operacion arranque por ahi. Sin esto, generar y revisar chocaban cada
 * una contra el modelo saturado y pagaban los reintentos por separado.
 */
async function dispatch(
  cfg: ProviderConfig,
  call: Call,
): Promise<{ data: unknown; model: string }> {
  if (!cfg.apiKey) throw new AiError('Falta la API key.', 'not_configured');
  if (!cfg.model) throw new AiError('Falta elegir el modelo.', 'not_configured');

  const tried = new Set<string>([cfg.model]);
  let lastError: unknown;

  try {
    return {
      data: await withRetry(() => callOne(cfg, call), call.retries),
      model: cfg.model,
    };
  } catch (error) {
    // Cambiar de modelo cuesta otra ronda entera de esperas. En una tarea
    // interactiva eso no se paga: que decida la mesa y el juego sigue.
    if (!call.allowModelSwitch || !worthSwitching(error)) throw error;
    lastError = error;
  }

  for (const model of await siblingModels(cfg, tried)) {
    tried.add(model);
    try {
      const data = await withRetry(() => callOne({ ...cfg, model }, call), 2);
      cfg.onModelSwitch?.(model);
      return { data, model };
    } catch (error) {
      if (!worthSwitching(error)) throw error;
      lastError = error;
    }
  }

  throw lastError;
}

export async function generateQuestions(
  cfg: ProviderConfig,
  raw: GenerateParams,
): Promise<GenerateResult> {
  const params = clampGenerateParams(raw);
  const { data, model } = await dispatch(cfg, {
    system: GENERATE_SYSTEM_PROMPT,
    user: buildGenerateUserPrompt(params),
    schema: generateSchema(params.count),
    schemaName: 'preguntas',
    effort: 'high',
    timeoutMs: TIMEOUTS.generate,
    retries: 3,
    allowModelSwitch: true,
    // Algo de azar para que no salgan siempre las mismas, pero poco: cada
    // decima de mas es una decima mas de datos inventados.
    temperature: 0.7,
    // ~220 tokens por pregunta con holgura para el razonamiento previo.
    maxTokens: Math.min(16000, 2000 + params.count * 400),
  });

  const parsed = generateResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new AiError(
      `El modelo devolvió preguntas con un formato inválido: ${parsed.error.issues[0]?.message ?? ''}`,
      'bad_output',
    );
  }

  // Revisamos con el modelo que efectivamente contesto, no con el que pedimos.
  const questions = await dropUnverified(
    { ...cfg, model },
    parsed.data.questions as GenerateResult['questions'],
  );
  return { questions };
}

/**
 * Segunda pasada sobre lo recien generado, para tirar lo que no se sostiene.
 *
 * Escribir veinte preguntas de un tiron y acertarle a todos los datos es mucho
 * pedirle a un modelo chico; revisarlas despues, de a una y sin el apuro de
 * inventar, es bastante mas facil. Cuesta una llamada mas, pero cae dentro de la
 * espera del arranque, que es la unica que el jugador acepta.
 *
 * Si la revision falla o viene rara, se devuelven todas: preferimos una pregunta
 * dudosa a una partida sin preguntas.
 */
async function dropUnverified(
  cfg: ProviderConfig,
  questions: GenerateResult['questions'],
): Promise<GenerateResult['questions']> {
  if (questions.length === 0) return questions;

  try {
    const { data } = await dispatch(cfg, {
      system: VERIFY_SYSTEM_PROMPT,
      user: buildVerifyUserPrompt(questions),
      schema: verifySchema(questions.length),
      schemaName: 'revision',
      effort: 'high',
      timeoutMs: TIMEOUTS.verify,
      retries: 2,
      allowModelSwitch: true,
      // Revisar no tiene nada de creativo: o el dato es cierto o no lo es.
      temperature: 0,
      maxTokens: Math.min(8000, 1000 + questions.length * 120),
    });

    const parsed = verifyResultSchema.safeParse(data);
    if (!parsed.success) return questions;

    const rejected = new Set(
      parsed.data.revisadas.filter((row) => !row.sirve).map((row) => row.n),
    );
    const kept = questions.filter((_, index) => !rejected.has(index + 1));

    // Si la revision se lleva puesto casi todo, algo entendio mal: mejor
    // devolver el mazo entero que dejar a la mesa sin nada.
    return kept.length >= Math.ceil(questions.length / 2) ? kept : questions;
  } catch {
    return questions;
  }
}

export async function judgeAnswer(cfg: ProviderConfig, raw: JudgeParams): Promise<JudgeResult> {
  const params = clampJudgeParams(raw);
  const { data } = await dispatch(cfg, {
    system: JUDGE_SYSTEM_PROMPT,
    user: buildJudgeUserPrompt(params),
    schema: judgeSchema,
    schemaName: 'veredicto',
    effort: 'low',
    temperature: 0,
    // Un veredicto son veinte palabras. Lo demas era margen para que el modelo
    // se fuera por las ramas.
    maxTokens: 1000,
    timeoutMs: TIMEOUTS.judge,
    // Ni reintentos ni cambio de modelo: la mesa esta esperando.
    retries: 1,
    allowModelSwitch: false,
  });

  const parsed = judgeResultSchema.safeParse(data);
  if (!parsed.success) {
    throw new AiError('El árbitro devolvió un veredicto ilegible.', 'bad_output');
  }
  return parsed.data as JudgeResult;
}

/** Lista los modelos que la key tiene habilitados, para el selector de Ajustes. */
export async function listModels(cfg: Omit<ProviderConfig, 'model'>): Promise<string[]> {
  if (!cfg.apiKey) throw new AiError('Falta la API key.', 'not_configured');

  if (cfg.provider === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: cfg.apiKey, dangerouslyAllowBrowser: true });
    const page = await client.models.list({ limit: 100 });
    return page.data.map((m) => m.id);
  }

  if (cfg.provider === 'gemini') {
    const response = await request(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      { headers: { 'x-goog-api-key': cfg.apiKey } },
      LIST_TIMEOUT_MS,
    );
    if (!response.ok) throw httpError(response.status, await response.text());
    const data = (await response.json()) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    return (data.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent') ?? true)
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  const base = OPENAI_COMPATIBLE[cfg.provider];
  if (!base) throw new AiError(`Proveedor desconocido: ${cfg.provider}.`, 'not_configured');
  const response = await request(
    `${base}/models`,
    { headers: { authorization: `Bearer ${cfg.apiKey}` } },
    LIST_TIMEOUT_MS,
  );
  if (!response.ok) throw httpError(response.status, await response.text());
  const data = (await response.json()) as { data?: { id?: string }[] };
  return (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
}
