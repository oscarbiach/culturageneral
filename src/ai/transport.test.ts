import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiClient } from './transport';
import { configProblem, defaultSettings, isProxyUrlUsable } from '../state/settings';
import { AiError } from '../shared/providers';

const base = defaultSettings();

afterEach(() => vi.unstubAllGlobals());

describe('direccion del servidor del grupo', () => {
  it('acepta una URL completa', () => {
    expect(isProxyUrlUsable('https://mano.midominio.workers.dev')).toBe(true);
    expect(isProxyUrlUsable('  http://localhost:8787  ')).toBe(true);
  });

  it('rechaza lo que no sirve para salir a la red', () => {
    // Una ruta relativa terminaba siendo un POST contra la propia GitHub Pages,
    // que contesta 405 sin explicar nada. Nunca mas.
    expect(isProxyUrlUsable('')).toBe(false);
    expect(isProxyUrlUsable('/ai')).toBe(false);
    expect(isProxyUrlUsable('mano.workers.dev')).toBe(false);
    expect(isProxyUrlUsable('javascript:alert(1)')).toBe(false);
  });
});

describe('configProblem', () => {
  it('avisa en castellano cuando falta la direccion del servidor', () => {
    const problem = configProblem({ ...base, connection: 'proxy', proxyUrl: '' });
    expect(problem).toMatch(/Mi propia key/);
  });

  it('avisa cuando la direccion esta a medias', () => {
    const problem = configProblem({ ...base, connection: 'proxy', proxyUrl: 'mano.workers.dev' });
    expect(problem).toMatch(/https:\/\//);
  });

  it('avisa cuando falta la API key en modo directo', () => {
    expect(configProblem({ ...base, connection: 'directa', apiKey: '' })).toMatch(/API key/);
  });

  it('no se queja cuando esta todo puesto', () => {
    expect(configProblem({ ...base, connection: 'proxy', proxyUrl: 'https://x.workers.dev' })).toBeNull();
    expect(
      configProblem({ ...base, connection: 'directa', apiKey: 'k', model: 'm' }),
    ).toBeNull();
  });
});

describe('cliente en modo servidor del grupo', () => {
  it('ni sale a la red si la direccion no sirve', async () => {
    const client = createAiClient(() => ({ ...base, connection: 'proxy', proxyUrl: '' }));
    await expect(
      client.generate({ brief: 'x', count: 1, difficulty: 'normal', avoid: [], feedback: [] }),
    ).rejects.toThrow(AiError);
    await expect(
      client.judge({ question: 'q', answer: 'a', accept: [], given: 'g' }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('el arbitro no molesta a la IA cuando no hace falta', () => {
  const settings = { ...base, connection: 'directa' as const, apiKey: 'k', model: 'm' };
  const pregunta = {
    question: '¿Qué arquero atajó dos penales en la final del Mundial 2022?',
    answer: 'Emiliano Martínez',
    accept: ['Dibu'],
  };

  it('una respuesta exacta se resuelve sin tocar la red', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const veredicto = await createAiClient(() => settings).judge({
      ...pregunta,
      given: 'emiliano martinez',
    });

    expect(veredicto.verdict).toBe('correcta');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rendirse tampoco cuesta un viaje', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const veredicto = await createAiClient(() => settings).judge({ ...pregunta, given: 'ni idea' });

    expect(veredicto.verdict).toBe('incorrecta');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pero una respuesta dudosa sí va a la IA', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              { content: { parts: [{ text: JSON.stringify({ verdict: 'parcial', reason: 'Le falta el nombre' }) }] } },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const veredicto = await createAiClient(() => ({ ...settings, provider: 'gemini' as const })).judge({
      ...pregunta,
      given: 'el arquero del aston villa',
    });

    expect(veredicto.verdict).toBe('parcial');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
