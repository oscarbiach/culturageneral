import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateQuestions, judgeAnswer, modelShape, resetModelCache, AiError } from './providers';

const cfg = { provider: 'gemini' as const, model: 'gemini-x-flash', apiKey: 'clave-de-mentira' };

const params = { brief: 'futbol', count: 1, difficulty: 'normal' as const, avoid: [], feedback: [] };

function geminiSays(payload: unknown) {
  return new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    { status: 200 },
  );
}

const OVERLOADED = JSON.stringify({
  error: {
    code: 503,
    message: 'This model is currently experiencing high demand.',
    status: 'UNAVAILABLE',
  },
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetModelCache();
});

describe('saturacion del modelo', () => {
  it('reintenta solo y sale adelante sin molestar al jugador', async () => {
    // Esto es literalmente el 503 que devolvio Gemini en la primera partida.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(OVERLOADED, { status: 503 }))
      .mockResolvedValueOnce(
        geminiSays({
          questions: [
            { prompt: '¿Quién ganó el Mundial 2022?', answer: 'Argentina', accept: [], topic: 'mundiales', difficulty: 'normal' },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateQuestions(cfg, params);
    expect(result.questions[0].answer).toBe('Argentina');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('si insiste, avisa en castellano y no escupe el JSON del proveedor', async () => {
    // mockImplementation y no mockResolvedValue: un Response se lee una sola vez,
    // asi que cada reintento necesita el suyo.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(OVERLOADED, { status: 503 })));

    await expect(generateQuestions(cfg, params)).rejects.toMatchObject({
      code: 'overloaded',
      message: expect.stringContaining('saturado'),
    });
  });

  it('el arbitro tambien reintenta: un 503 no puede colgar una respuesta', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(OVERLOADED, { status: 503 }))
      .mockResolvedValueOnce(geminiSays({ verdict: 'correcta', reason: 'Con el apodo alcanza' }));
    vi.stubGlobal('fetch', fetchMock);

    const veredicto = await judgeAnswer(cfg, {
      question: '¿Quién atajó los penales?',
      answer: 'Emiliano Martínez',
      accept: ['Dibu'],
      given: 'el dibu',
    });
    expect(veredicto.verdict).toBe('correcta');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('errores que no se arreglan esperando', () => {
  it('un pedido mal formado no se reintenta: nunca va a salir bien', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"bad request"}', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateQuestions(cfg, params)).rejects.toBeInstanceOf(AiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('una key rechazada no se reintenta: seria perder el tiempo', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateQuestions(cfg, params)).rejects.toMatchObject({ code: 'unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('pasarse de la cuota tampoco: hay que esperar de verdad', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateQuestions(cfg, params)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('el error nunca puede arrastrar la key', () => {
  it('la tapa aunque el proveedor la devuelva en el cuerpo', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"invalid key AIzaSyD1234567890abcdefgh"}', { status: 400 })),
    );

    const error = (await generateQuestions(cfg, params).catch((e) => e)) as AiError;
    expect(error.message).not.toContain('AIzaSy');
    expect(error.message).toContain('***');
  });
});

describe('cambio automatico de modelo', () => {
  it('lee la familia y la version del nombre, sin listas escritas a mano', () => {
    expect(modelShape('gemini-3.8-flash')).toEqual({ words: 'gemini-flash', version: 3.8 });
    expect(modelShape('google/gemini-3.7-flash')).toEqual({ words: 'gemini-flash', version: 3.7 });
    expect(modelShape('claude-opus-4-8')).toEqual({ words: 'claude-opus', version: 4 });
    // Un modelo de otra familia no puede colarse como reemplazo.
    expect(modelShape('gemini-3.8-pro').words).not.toBe(modelShape('gemini-3.8-flash').words);
    expect(modelShape('gemini-embedding-001').words).not.toBe('gemini-flash');
  });

  it('baja de generacion cuando el modelo esta saturado, y avisa cual quedo', async () => {
    const switched: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/models?')) {
        return new Response(
          JSON.stringify({
            models: [
              { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.7-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] },
            ],
          }),
          { status: 200 },
        );
      }
      // El 3.8 esta saturado siempre; el 3.7 anda.
      if (String(url).includes('gemini-3.8-flash')) {
        return new Response(OVERLOADED, { status: 503 });
      }
      return geminiSays({
        questions: [
          { prompt: '¿Quién ganó el Mundial 2022?', answer: 'Argentina', accept: [], topic: 'm', difficulty: 'normal' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateQuestions(
      { ...cfg, model: 'gemini-3.8-flash', onModelSwitch: (m) => switched.push(m) },
      params,
    );

    expect(result.questions[0].answer).toBe('Argentina');
    // Bajó a 3.7 y no saltó al Pro, que es de otra familia.
    expect(switched).toEqual(['gemini-3.7-flash']);
  });

  it('tambien cambia si el modelo elegido no existe', async () => {
    const switched: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).includes('/models?')) {
          return new Response(
            JSON.stringify({ models: [{ name: 'models/gemini-3.6-flash' }] }),
            { status: 200 },
          );
        }
        if (String(url).includes('gemini-9.9-flash')) {
          return new Response('{"error":{"code":404,"status":"NOT_FOUND"}}', { status: 404 });
        }
        return geminiSays({ verdict: 'correcta', reason: 'ok' });
      }),
    );

    const veredicto = await judgeAnswer(
      { ...cfg, model: 'gemini-9.9-flash', onModelSwitch: (m) => switched.push(m) },
      { question: 'q', answer: 'a', accept: [], given: 'a' },
    );
    expect(veredicto.verdict).toBe('correcta');
    expect(switched).toEqual(['gemini-3.6-flash']);
  });

  it('no cambia de modelo por una key rechazada: fallaria igual en todos', async () => {
    const switched: string[] = [];
    const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateQuestions({ ...cfg, onModelSwitch: (m) => switched.push(m) }, params),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(switched).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
