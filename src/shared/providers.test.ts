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
    // El 503, el reintento que salió bien, y la pasada de revisión.
    expect(fetchMock).toHaveBeenCalledTimes(3);
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

  it('el arbitro NO reintenta ni cambia de modelo: la mesa esta esperando', async () => {
    // Reintentar tres veces y despues encadenar modelos alternativos convertia
    // una respuesta lenta en una espera de minutos, con la gente mirando el
    // telefono. Ante un fallo, falla rapido y decide la mesa.
    const fetchMock = vi.fn(async () => new Response(OVERLOADED, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      judgeAnswer(cfg, {
        question: '¿Quién atajó los penales?',
        answer: 'Emiliano Martínez',
        accept: ['Dibu'],
        given: 'el dibu',
      }),
    ).rejects.toBeInstanceOf(AiError);

    // Una sola llamada. Ni reintentos, ni lista de modelos, ni alternativas.
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    // Bajó a 3.7 y no saltó al Pro, que es de otra familia. Generar y revisar
    // son dos llamadas, así que puede avisar una vez por cada una; la pantalla
    // se encarga de no repetir el cartel.
    expect([...new Set(switched)]).toEqual(['gemini-3.7-flash']);
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
        return geminiSays({
          questions: [
            { prompt: '¿Quién ganó el Mundial 2022?', answer: 'Argentina', accept: [], topic: 'm', difficulty: 'normal' },
          ],
          revisadas: [{ n: 1, sirve: true }],
        });
      }),
    );

    const result = await generateQuestions(
      { ...cfg, model: 'gemini-9.9-flash', onModelSwitch: (m) => switched.push(m) },
      params,
    );
    expect(result.questions).toHaveLength(1);
    expect([...new Set(switched)]).toEqual(['gemini-3.6-flash']);
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

describe('la revisión de las preguntas antes de que salgan a la mesa', () => {
  const dosPreguntas = {
    questions: [
      { prompt: '¿Quién ganó el Mundial 2022?', answer: 'Argentina', accept: [], topic: 'm', difficulty: 'normal' },
      { prompt: '¿En cuántas finales marcó Messi?', answer: 'Dos', accept: [], topic: 'm', difficulty: 'normal' },
    ],
  };

  function conRevision(revisadas: { n: number; sirve: boolean }[]) {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      return geminiSays(call === 1 ? dosPreguntas : { revisadas });
    });
  }

  it('tira la pregunta que el revisor no puede confirmar', async () => {
    vi.stubGlobal('fetch', conRevision([
      { n: 1, sirve: true },
      { n: 2, sirve: false },
    ]));

    const result = await generateQuestions(cfg, { ...params, count: 2 });
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].answer).toBe('Argentina');
  });

  it('deja pasar las que sí se sostienen', async () => {
    vi.stubGlobal('fetch', conRevision([
      { n: 1, sirve: true },
      { n: 2, sirve: true },
    ]));

    const result = await generateQuestions(cfg, { ...params, count: 2 });
    expect(result.questions).toHaveLength(2);
  });

  it('si el revisor se lleva puesto casi todo, desconfía de él y no de las preguntas', async () => {
    // Un revisor que descarta el mazo entero entendió mal la consigna. Mejor una
    // pregunta dudosa que una mesa sin nada que jugar.
    vi.stubGlobal('fetch', conRevision([
      { n: 1, sirve: false },
      { n: 2, sirve: false },
    ]));

    const result = await generateQuestions(cfg, { ...params, count: 2 });
    expect(result.questions).toHaveLength(2);
  });

  it('si la revisión se cae, la partida arranca igual', async () => {
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      if (call === 1) return geminiSays(dosPreguntas);
      return new Response('{"error":"se cayó"}', { status: 400 });
    }));

    const result = await generateQuestions(cfg, { ...params, count: 2 });
    expect(result.questions).toHaveLength(2);
  });
});

describe('techos de tiempo', () => {
  it('el árbitro corta a los pocos segundos en vez de colgar la partida', async () => {
    // Una petición que nunca contesta: antes se quedaba esperando para siempre,
    // y encima la repetía en otros modelos.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ),
    );

    const empezo = Date.now();
    const error = (await judgeAnswer(cfg, {
      question: '¿Quién?',
      answer: 'Alguien',
      accept: [],
      given: 'otra cosa',
    }).catch((e) => e)) as AiError;

    expect(error).toBeInstanceOf(AiError);
    expect(error.code).toBe('timeout');
    // Nueve segundos de techo, con margen para la máquina de tests.
    expect(Date.now() - empezo).toBeLessThan(15_000);
  }, 20_000);

  it('un timeout no se reintenta: si tardó una vez, va a volver a tardar', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      judgeAnswer(cfg, { question: 'q', answer: 'a', accept: [], given: 'b' }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 20_000);
});
