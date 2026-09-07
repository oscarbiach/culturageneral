import { describe, expect, it } from 'vitest';
import { createAiClient } from './transport';
import { configProblem, defaultSettings, isProxyUrlUsable } from '../state/settings';
import { AiError } from '../shared/providers';

const base = defaultSettings();

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
    const client = createAiClient({ ...base, connection: 'proxy', proxyUrl: '' });
    await expect(
      client.generate({ brief: 'x', count: 1, difficulty: 'normal', avoid: [], feedback: [] }),
    ).rejects.toThrow(AiError);
    await expect(
      client.judge({ question: 'q', answer: 'a', accept: [], given: 'g' }),
    ).rejects.toMatchObject({ code: 'not_configured' });
  });
});
