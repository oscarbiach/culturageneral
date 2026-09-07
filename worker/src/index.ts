/**
 * Proxy de IA para Mano a Mano.
 *
 * La app vive en GitHub Pages, que es hosting estatico y no puede guardar un
 * secreto. Este Worker es el unico lugar donde esta la API key: recibe pedidos
 * acotados ("generame 8 preguntas asi", "juzga esta respuesta"), arma el prompt
 * el mismo y llama al proveedor.
 *
 * Que reciba tareas y no prompts libres es a proposito: asi nadie que encuentre
 * la URL puede usarlo como un chatbot gratis con la key de otro.
 */

import {
  PROTOCOL_VERSION,
  clampGenerateParams,
  clampJudgeParams,
  type AiErrorBody,
  type ProviderId,
} from '../../src/shared/contracts';
import { AiError, generateQuestions, judgeAnswer } from '../../src/shared/providers';

export interface Env {
  /** Proveedor y modelo que paga el duenio del Worker. */
  PROVIDER?: string;
  MODEL?: string;

  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;

  /** Si esta puesto, la app tiene que mandarlo en el header x-mano-code. */
  ACCESS_CODE?: string;
  /** Origenes permitidos, separados por coma. Vacio o "*" deja pasar a todos. */
  ALLOWED_ORIGINS?: string;
  /** "true" deja que la app elija proveedor y modelo. Por defecto manda el Worker. */
  ALLOW_CLIENT_MODEL?: string;
  /** Pedidos por IP por hora. 0 desactiva el limite. */
  RATE_LIMIT?: string;
  /** KV opcional para el limite de uso. Sin esto no hay limite. */
  RATE?: KVNamespace;
}

const KEY_BY_PROVIDER: Record<ProviderId, keyof Env> = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const VALID_PROVIDERS = Object.keys(KEY_BY_PROVIDER) as ProviderId[];

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const allowed = (env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = request.headers.get('origin') ?? '';
  const open = allowed.length === 0 || allowed.includes('*');
  const ok = open || allowed.includes(origin);

  return {
    'access-control-allow-origin': open ? '*' : ok ? origin : 'null',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type, x-mano-code',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });
}

function fail(
  message: string,
  code: AiErrorBody['code'],
  status: number,
  headers: Record<string, string>,
): Response {
  return json({ error: message, code } satisfies AiErrorBody, status, headers);
}

/**
 * Limite por IP con KV. Es un contador por hora, no una ventana deslizante: para
 * frenar a alguien que encontro la URL alcanza, y evita escribir en KV a cada rato.
 */
async function overLimit(request: Request, env: Env): Promise<boolean> {
  const limit = Number(env.RATE_LIMIT ?? '0');
  if (!env.RATE || !limit) return false;

  const ip = request.headers.get('cf-connecting-ip') ?? 'desconocida';
  const hour = new Date().toISOString().slice(0, 13);
  const key = `rate:${hour}:${ip}`;
  const used = Number((await env.RATE.get(key)) ?? '0');
  if (used >= limit) return true;
  // Expira solo: no hace falta limpiar nada.
  await env.RATE.put(key, String(used + 1), { expirationTtl: 3900 });
  return false;
}

function resolveProvider(env: Env, requested?: string): ProviderId {
  const fallback = (VALID_PROVIDERS.includes(env.PROVIDER as ProviderId)
    ? env.PROVIDER
    : 'gemini') as ProviderId;
  if (env.ALLOW_CLIENT_MODEL !== 'true') return fallback;
  return VALID_PROVIDERS.includes(requested as ProviderId) ? (requested as ProviderId) : fallback;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);

    if (url.pathname === '/health') {
      const provider = resolveProvider(env);
      return json(
        {
          ok: true,
          protocol: PROTOCOL_VERSION,
          provider,
          model: env.MODEL ?? '(por defecto del proveedor)',
          keyConfigured: Boolean(env[KEY_BY_PROVIDER[provider]]),
          accessCodeRequired: Boolean(env.ACCESS_CODE),
          rateLimit: env.RATE ? Number(env.RATE_LIMIT ?? '0') : 'sin KV, desactivado',
        },
        200,
        cors,
      );
    }

    if (url.pathname !== '/ai') return fail('No existe esa ruta.', 'bad_request', 404, cors);
    if (request.method !== 'POST') return fail('Usá POST.', 'bad_request', 405, cors);

    if (env.ACCESS_CODE && request.headers.get('x-mano-code') !== env.ACCESS_CODE) {
      return fail('Código de acceso incorrecto.', 'unauthorized', 401, cors);
    }

    if (await overLimit(request, env)) {
      return fail('Se llegó al límite de uso por hora. Probá más tarde.', 'rate_limited', 429, cors);
    }

    let body: { v?: number; task?: string; params?: unknown; provider?: string; model?: string };
    try {
      body = await request.json();
    } catch {
      return fail('El cuerpo del pedido no es JSON.', 'bad_request', 400, cors);
    }

    if (body.v !== PROTOCOL_VERSION) {
      return fail(
        'La app y el servidor no hablan la misma versión. Recargá la página.',
        'bad_request',
        400,
        cors,
      );
    }

    // La tarea se valida antes que la configuracion: un pedido invalido no tiene
    // por que enterarse de si al Worker le falta una key o no.
    if (body.task !== 'generate' && body.task !== 'judge') {
      return fail('Tarea desconocida.', 'bad_request', 400, cors);
    }

    const provider = resolveProvider(env, body.provider);
    const apiKey = env[KEY_BY_PROVIDER[provider]] as string | undefined;
    if (!apiKey) {
      return fail(
        `Al servidor le falta la API key de ${provider}.`,
        'not_configured',
        500,
        cors,
      );
    }

    const cfg = {
      provider,
      apiKey,
      model:
        (env.ALLOW_CLIENT_MODEL === 'true' ? body.model : undefined) ||
        env.MODEL ||
        defaultModelFor(provider),
    };

    try {
      if (body.task === 'generate') {
        const result = await generateQuestions(cfg, clampGenerateParams(body.params as never));
        return json(result, 200, cors);
      }
      const result = await judgeAnswer(cfg, clampJudgeParams(body.params as never));
      return json(result, 200, cors);
    } catch (error) {
      if (error instanceof AiError) {
        const status =
          error.code === 'rate_limited' ? 429 : error.code === 'overloaded' ? 503 : 502;
        // La key nunca puede filtrarse en el mensaje que ve el jugador: los
        // proveedores a veces la repiten en el cuerpo del error.
        return fail(redactKeys(error.message), error.code, status, cors);
      }
      console.error(error);
      return fail('El servidor no pudo generar las preguntas.', 'provider_error', 502, cors);
    }
  },
};

/** Tapa cualquier cosa con pinta de API key: sk-…, AIza…, gsk_…, sk-or-…. */
function redactKeys(message: string): string {
  return message
    .replace(/\b(sk|gsk|sk-or|xai)[-_][A-Za-z0-9_-]{8,}/gi, '***')
    .replace(/\bAIza[A-Za-z0-9_-]{10,}/g, '***');
}

function defaultModelFor(provider: ProviderId): string {
  switch (provider) {
    case 'anthropic':
      return 'claude-opus-5';
    case 'openai':
      return 'gpt-5.6';
    case 'groq':
      return 'llama-3.3-70b-versatile';
    case 'openrouter':
      return 'google/gemini-3.8-flash';
    default:
      return 'gemini-3.8-flash';
  }
}
