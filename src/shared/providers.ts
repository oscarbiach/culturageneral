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
  buildGenerateUserPrompt,
  buildJudgeUserPrompt,
  generateSchema,
  judgeSchema,
} from './prompts';
import { extractJson, generateResultSchema, judgeResultSchema } from './schemas';

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  apiKey: string;
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
    defaultModel: 'gemini-3.8-flash',
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
      | 'provider_error'
      | 'refusal'
      | 'bad_output'
      | 'not_configured',
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

function httpError(status: number, body: string): AiError {
  const detail = redactKeys(body.slice(0, 300));
  if (status === 401 || status === 403) {
    return new AiError(`El proveedor rechazó la API key (${status}). ${detail}`, 'unauthorized');
  }
  if (status === 429) {
    return new AiError('Te pasaste del límite del proveedor. Esperá un rato.', 'rate_limited');
  }
  return new AiError(`El proveedor respondió ${status}. ${detail}`, 'provider_error');
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
  /** Cuanto esfuerzo pedirle al modelo. Juzgar es barato; generar no. */
  heavy: boolean;
  maxTokens: number;
}

async function callAnthropic(cfg: ProviderConfig, call: Call): Promise<unknown> {
  // El SDK oficial se carga en demanda: en el telefono no queremos pagar el peso
  // del bundle si el jugador usa otro proveedor.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({
    apiKey: cfg.apiKey,
    // Necesario cuando la app llama directo desde el navegador con la key del
    // propio jugador. En el Worker no cambia nada.
    dangerouslyAllowBrowser: true,
  });

  try {
    const response = await client.messages.create({
      model: cfg.model,
      max_tokens: call.maxTokens,
      system: call.system,
      messages: [{ role: 'user', content: call.user }],
      output_config: {
        effort: call.heavy ? 'medium' : 'low',
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
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: call.system }] },
      contents: [{ role: 'user', parts: [{ text: call.user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(call.schema),
        maxOutputTokens: call.maxTokens,
        temperature: call.heavy ? 1 : 0,
      },
    }),
  });

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
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
        // OpenRouter los pide para atribuir el trafico; el resto los ignora.
        'http-referer': 'https://github.com/oscarbiach/culturageneral',
        'x-title': 'Mano a Mano',
      },
      body: JSON.stringify(payload),
    });

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

async function dispatch(cfg: ProviderConfig, call: Call): Promise<unknown> {
  if (!cfg.apiKey) throw new AiError('Falta la API key.', 'not_configured');
  if (!cfg.model) throw new AiError('Falta elegir el modelo.', 'not_configured');
  if (cfg.provider === 'anthropic') return callAnthropic(cfg, call);
  if (cfg.provider === 'gemini') return callGemini(cfg, call);
  return callOpenAiCompatible(cfg, call);
}

export async function generateQuestions(
  cfg: ProviderConfig,
  raw: GenerateParams,
): Promise<GenerateResult> {
  const params = clampGenerateParams(raw);
  const data = await dispatch(cfg, {
    system: GENERATE_SYSTEM_PROMPT,
    user: buildGenerateUserPrompt(params),
    schema: generateSchema(params.count),
    schemaName: 'preguntas',
    heavy: true,
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
  return parsed.data as GenerateResult;
}

export async function judgeAnswer(cfg: ProviderConfig, raw: JudgeParams): Promise<JudgeResult> {
  const params = clampJudgeParams(raw);
  const data = await dispatch(cfg, {
    system: JUDGE_SYSTEM_PROMPT,
    user: buildJudgeUserPrompt(params),
    schema: judgeSchema,
    schemaName: 'veredicto',
    heavy: false,
    maxTokens: 2000,
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
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',
      { headers: { 'x-goog-api-key': cfg.apiKey } },
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
  const response = await fetch(`${base}/models`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
  });
  if (!response.ok) throw httpError(response.status, await response.text());
  const data = (await response.json()) as { data?: { id?: string }[] };
  return (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
}
