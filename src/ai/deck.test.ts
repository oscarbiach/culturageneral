import { describe, expect, it, vi } from 'vitest';
import { Deck, planBatches, splitEvenly } from './deck';
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
  };
  return { client, calls };
}

/** Deja correr las promesas de precarga pendientes. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Espera tambien el escalonado entre tandas, que es de cientos de ms. */
const settleAll = () => new Promise((resolve) => setTimeout(resolve, 800));

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

    const primera = await deck.take();
    // Vaciamos el mazo para forzar la recarga y poder mirar que le pide.
    // El tope evita quedarse en el bucle si algo cambia: el mazo se rellena solo.
    for (let i = 0; i < 40 && deck.pending > 0; i += 1) await deck.take();
    await settle();

    const refill = calls[calls.length - 1];
    expect(refill.avoid).toContain(primera.prompt);
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

describe('preparar el mazo de entrada', () => {
  it('deja jugar apenas llega la primera tanda, sin esperar el mazo entero', async () => {
    // En un objeto y no en una variable suelta: TypeScript no ve que el
    // callback asincrónico la asigna, y la estrecha a `never`.
    const soltar: { segunda?: () => void } = {};
    const calls: number[] = [];
    const client = {
      generate: async (params: { count: number }) => {
        calls.push(params.count);
        // La primera tanda contesta ya; la segunda se cuelga hasta que la soltemos.
        if (calls.length > 1) {
          await new Promise<void>((resolve) => {
            soltar.segunda = resolve;
          });
        }
        return {
          questions: Array.from({ length: params.count }, (_, i) => ({
            prompt: `Pregunta ${calls.length}-${i}`,
            answer: 'R',
            accept: [],
            topic: 't',
            difficulty: 'normal' as const,
          })),
        };
      },
    };
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.preload(20);

    // Ya se puede jugar aunque la tanda grande ni siquiera haya salido todavía.
    expect(deck.pending).toBe(5);
    expect(calls).toEqual([5]);

    await settleAll();
    expect(calls.length).toBe(2);
    soltar.segunda?.();
  });

  it('el resto del mazo entra mientras se juegan las primeras', async () => {
    const { client } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.preload(20);
    const alArrancar = deck.pending;
    await settleAll();

    expect(alArrancar).toBe(5);
    expect(deck.pending).toBe(20);
  });

  it('con el mazo ya lleno, servir una pregunta no toca la red', async () => {
    const { client, calls } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.preload(20);
    await settleAll();
    const antes = calls.length;
    for (let i = 0; i < 10; i += 1) await deck.take();

    expect(calls.length).toBe(antes);
  });

  it('avisa el avance para poder mostrarlo mientras se espera', async () => {
    const avance: number[] = [];
    const { client } = fakeClient();
    const deck = new Deck(client, {
      brief: 'futbol',
      difficulty: 'normal',
      onProgress: (ready) => avance.push(ready),
    });

    await deck.preload(20);
    await settleAll();
    expect(avance.length).toBeGreaterThan(1);
    expect(avance[avance.length - 1]).toBe(20);
  });

  it('descarta las repetidas que traigan dos pedidos que no se vieron', async () => {
    // Los pedidos salen juntos y no comparten el `avoid`, asi que pueden pisarse.
    let call = 0;
    const client = {
      generate: async (params: { count: number }) => {
        call += 1;
        return {
          questions: Array.from({ length: params.count }, (_, i) => ({
            // El segundo pedido devuelve lo mismo, con tildes y mayúsculas distintas.
            prompt: call === 1 ? `Pregunta ${i}` : `PREGUNTÁ ${i}`.replace('Á', 'a'),
            answer: `R${i}`,
            accept: [],
            topic: 't',
            difficulty: 'normal' as const,
          })),
        };
      },
    };
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.preload(20);
    await settleAll();
    expect(deck.pending).toBeLessThan(20);
    expect(deck.pending).toBeGreaterThan(0);
  });

  it('con un pedido caído arranca igual con lo que sí llegó', async () => {
    let call = 0;
    const client = {
      generate: async (params: { count: number }) => {
        call += 1;
        if (call === 2) throw new Error('se cayó ese pedido');
        return {
          questions: Array.from({ length: params.count }, (_, i) => ({
            prompt: `Pregunta ${call}-${i}`,
            answer: 'R',
            accept: [],
            topic: 't',
            difficulty: 'normal' as const,
          })),
        };
      },
    };
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.preload(20);
    expect(deck.pending).toBeGreaterThan(0);
  });
});

describe('splitEvenly', () => {
  it('reparte parejo, para que el más lento tarde poco', () => {
    expect(splitEvenly(20, 3)).toEqual([7, 7, 6]);
    expect(splitEvenly(10, 3)).toEqual([4, 3, 3]);
  });

  it('no parte de más: un pedido de una sola pregunta no vale el viaje', () => {
    expect(splitEvenly(3, 3)).toEqual([3]);
    expect(splitEvenly(1, 3)).toEqual([1]);
  });

  it('nunca se pasa del techo por pedido', () => {
    const grande = splitEvenly(40, 3);
    expect(grande.reduce((a, b) => a + b, 0)).toBe(40);
    expect(grande.every((n) => n > 0 && n <= 15)).toBe(true);
  });
});

describe('no gasta cuota de mas', () => {
  it('deja de pedir cuando ya tiene las preguntas de la partida', async () => {
    const { client, calls } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    await deck.preload(10);
    await settleAll();
    const pedidosIniciales = calls.length;

    // Se juega la partida entera.
    for (let i = 0; i < 10; i += 1) {
      await deck.take();
      await settle();
    }

    // Ni un pedido mas: nadie va a ver una pregunta doce.
    expect(calls.length).toBe(pedidosIniciales);
  });

  it('para una partida larga completa por atras, sin pasarse', async () => {
    const { client, calls } = fakeClient();
    const deck = new Deck(client, { brief: 'futbol', difficulty: 'normal' });

    // 30 rondas: la precarga tiene tope, el resto entra mientras se juega.
    await deck.preload(30);
    await settleAll();
    for (let i = 0; i < 30; i += 1) {
      await deck.take();
      await settle();
    }

    const pedidas = calls.reduce((total, call) => total + call.count, 0);
    expect(pedidas).toBeGreaterThanOrEqual(30);
    // Un margen chico se banca; el derroche no.
    expect(pedidas).toBeLessThanOrEqual(42);
  });
});

describe('planBatches', () => {
  it('pone una tanda corta adelante: es la única que frena el arranque', () => {
    expect(planBatches(20)).toEqual([5, 15]);
    expect(planBatches(10)).toEqual([5, 5]);
  });

  it('en partidas cortas no parte al pedo', () => {
    expect(planBatches(5)).toEqual([5]);
    expect(planBatches(3)).toEqual([3]);
  });

  it('suma siempre el total pedido', () => {
    for (const total of [1, 4, 7, 12, 20]) {
      expect(planBatches(total).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });
});
