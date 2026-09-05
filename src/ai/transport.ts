/**
 * Decide por donde sale cada pedido de IA.
 *
 * Camino normal: el Cloudflare Worker del duenio, que tiene la key. Camino
 * avanzado: el navegador llamando al proveedor con la key del propio jugador,
 * util para probar antes de desplegar el Worker.
 */

import {
  PROTOCOL_VERSION,
  type AiErrorBody,
  type AiRequest,
  type GenerateParams,
  type GenerateResult,
  type JudgeParams,
  type JudgeResult,
} from '../shared/contracts';
import { AiError, generateQuestions, judgeAnswer } from '../shared/providers';
import type { AppSettings } from '../state/settings';

export interface AiClient {
  generate(params: GenerateParams, signal?: AbortSignal): Promise<GenerateResult>;
  judge(params: JudgeParams, signal?: AbortSignal): Promise<JudgeResult>;
}

async function viaProxy<T>(
  settings: AppSettings,
  task: AiRequest['task'],
  params: GenerateParams | JudgeParams,
  signal?: AbortSignal,
): Promise<T> {
  const base = settings.proxyUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.accessCode) headers['x-mano-code'] = settings.accessCode;

  let response: Response;
  try {
    response = await fetch(`${base}/ai`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        v: PROTOCOL_VERSION,
        task,
        params,
        provider: settings.provider,
        model: settings.model,
      } satisfies AiRequest),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new AiError(
      'No se pudo hablar con el servidor de preguntas. Fijate la conexión.',
      'provider_error',
    );
  }

  if (!response.ok) {
    let body: Partial<AiErrorBody> = {};
    try {
      body = (await response.json()) as AiErrorBody;
    } catch {
      // el Worker puede caerse antes de escribir JSON
    }
    throw new AiError(
      body.error ?? `El servidor de preguntas respondió ${response.status}.`,
      body.code && body.code !== 'bad_request' ? body.code : 'provider_error',
    );
  }

  return (await response.json()) as T;
}

export function createAiClient(settings: AppSettings): AiClient {
  if (settings.connection === 'proxy') {
    return {
      generate: (params, signal) => viaProxy<GenerateResult>(settings, 'generate', params, signal),
      judge: (params, signal) => viaProxy<JudgeResult>(settings, 'judge', params, signal),
    };
  }

  const cfg = {
    provider: settings.provider,
    model: settings.model,
    apiKey: settings.apiKey,
  };
  return {
    generate: (params) => generateQuestions(cfg, params),
    judge: (params) => judgeAnswer(cfg, params),
  };
}
