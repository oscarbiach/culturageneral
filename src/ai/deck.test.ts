import { describe, expect, it, vi } from 'vitest';
import { Deck } from './deck';
import type { GenerateParams, GenerateResult } from '../shared/contracts';
import type { AiClient } from './transport';

/** Cliente de mentira: cuenta llamadas y devuelve preguntas numeradas. */
function fakeClient() {
  const calls: GenerateParams[] = [];
  let serial = 0;
  const client: AiClient = {
    generate: async (params) => {
      calls.push(params);
      return {
        questions: Array.from({ length: params.count }, () => {
          serial += 1;
          return {
            prompt: `Pregunta ${serial}`,
            answer: `Respuesta ${serial}`,
            accept: [],
            topic: 'test',
            difficulty: params.difficulty,
          };
        }),
      } satisfies GenerateResult;
    },
    judge: async () => ({ verdict: 'correcta', reason: '' }),
  };
  return { client, calls };
}

/** Deja correr las promesas de precarga pendientes. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Deck', () => {
  it('sirve preguntas distintas una tras otra', async () => {
    const { client } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    const first = await deck.take();
    const second = await deck.take();
    expect(first.prompt).not.toBe(second.prompt);
    expect(first.id).not.toBe(second.id);
  });

  it('sigue recargando mucho despues de la primera tanda', async () => {
    // Esta es la regresion que rompio una partida entera: la precarga quedaba
    // colgada y a la quinta pregunta el mazo se vaciaba.
    const { client } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    const seen = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      const question = await deck.take();
      seen.add(question.prompt);
      await settle();
    }
    expect(seen.size).toBe(30);
  });

  it('pide tandas en vez de ir de a una', async () => {
    const { client, calls } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.take();
    await settle();
    expect(calls[0].count).toBeGreaterThan(1);
    // Con una sola pregunta consumida ya hay mas esperando en la cola.
    expect(deck.pending).toBeGreaterThan(0);
  });

  it('no repite: manda lo ya jugado y lo que espera en la cola', async () => {
    const { client, calls } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    const first = await deck.take();
    await settle();
    const refill = calls[1];
    expect(refill).toBeDefined();
    expect(refill.avoid).toContain(first.prompt);
    expect(refill.avoid.length).toBeGreaterThan(1);
  });

  it('una correccion tira lo precargado para que se note enseguida', async () => {
    const { client, calls } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.take();
    await settle();
    expect(deck.pending).toBeGreaterThan(0);

    deck.correct('están muy difíciles');
    expect(deck.pending).toBe(0);
    expect(deck.corrections).toEqual(['están muy difíciles']);

    await deck.take();
    expect(calls[calls.length - 1].feedback).toEqual(['están muy difíciles']);
  });

  it('cambiar el nivel tambien descarta lo precargado', async () => {
    const { client, calls } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.take();
    await settle();
    deck.setDifficulty('brutal');
    expect(deck.pending).toBe(0);

    await deck.take();
    expect(calls[calls.length - 1].difficulty).toBe('brutal');
  });

  it('un fallo de precarga no rompe la partida: se reintenta al pedir', async () => {
    const { client } = fakeClient();
    const original = client.generate;
    let failed = false;
    client.generate = async (params) => {
      if (!failed) {
        failed = true;
        throw new Error('se cayo la red');
      }
      return original(params);
    };
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await expect(deck.take()).rejects.toThrow('se cayo la red');
    const question = await deck.take();
    expect(question.prompt).toBeTruthy();
  });

  it('propaga el error si el generador vuelve con las manos vacias', async () => {
    const client: AiClient = {
      generate: async () => ({ questions: [] }),
      judge: async () => ({ verdict: 'correcta', reason: '' }),
    };
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });
    await expect(deck.take()).rejects.toThrow(/ninguna pregunta/);
  });
});

describe('Deck bajo StrictMode', () => {
  it('dos take() en paralelo devuelven preguntas distintas', async () => {
    // React en modo estricto monta el efecto dos veces; el segundo `take` no
    // puede devolver la misma pregunta que el primero.
    const { client } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    const [a, b] = await Promise.all([deck.take(), deck.take()]);
    expect(a.prompt).not.toBe(b.prompt);
  });
});

// Silencia el ruido de las precargas que quedan colgando al terminar los tests.
vi.spyOn(console, 'error').mockImplementation(() => {});
