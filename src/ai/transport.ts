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
import { isProxyUrlUsable, type AppSettings } from '../state/settings';

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
  // Sin esta guarda, una URL vacia dejaba la peticion en `/ai` relativo, que en
  // GitHub Pages termina siendo un POST contra el propio sitio: contesta 405 y
  // el jugador se come un numero sin ninguna pista de que hacer.
  if (!isProxyUrlUsable(settings.proxyUrl)) {
    throw new AiError(
      'Falta la dirección del servidor del grupo. Si todavía no montaste uno, entrá a Ajustes y elegí «Mi propia key».',
      'not_configured',
    );
  }

  const base = settings.proxyUrl.trim().replace(/\/+$/, '');
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

/**
 * `getSettings` es una funcion y no un objeto a proposito: el cliente sobrevive a
 * toda la partida, y si en el medio la app cambia de modelo por saturacion, el
 * proximo pedido tiene que salir ya con el nuevo.
 */
export function createAiClient(
  getSettings: () => AppSettings,
  onModelSwitch?: (model: string) => void,
): AiClient {
  const config = () => {
    const settings = getSettings();
    return {
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
      onModelSwitch,
    };
  };

  return {
    generate: (params, signal) =>
      getSettings().connection === 'proxy'
        ? viaProxy<GenerateResult>(getSettings(), 'generate', params, signal)
        : generateQuestions(config(), params),
    judge: (params, signal) =>
      getSettings().connection === 'proxy'
        ? viaProxy<JudgeResult>(getSettings(), 'judge', params, signal)
        : judgeAnswer(config(), params),
  };
}
