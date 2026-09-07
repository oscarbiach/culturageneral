/**
 * El mazo de preguntas.
 *
 * La regla de esta pantalla la puso la mesa: esperar al principio se banca,
 * esperar en el medio de la partida no. Asi que al arrancar se genera el mazo
 * entero, en varios pedidos en paralelo, y despues el juego no vuelve a tocar la
 * red salvo para el arbitro.
 *
 * Es tambien el que recuerda que salio ya y que correcciones fue pidiendo la mesa.
 */

import { LIMITS, type Difficulty } from '../shared/contracts';
import type { Question } from '../game/types';
import type { AiClient } from './transport';

/** Un pedido mas grande que esto tarda mas de lo que conviene esperar. */
const PER_REQUEST = Math.min(12, LIMITS.maxCount);
/** Y uno mas chico que esto no vale el viaje: mejor sumarlo a otro. */
const MIN_PER_REQUEST = 3;
/**
 * Cuantos pedidos salen juntos al preparar el mazo.
 *
 * Dos y no mas: cada tanda son en realidad dos llamadas (generar y revisar), y
 * los cupos gratuitos se miden por minuto. Tres tandas eran seis pedidos en el
 * mismo segundo, que es exactamente como se choca contra el limite.
 */
const PARALLEL = 2;
/** Separacion entre pedidos simultaneos, para no golpear todos en el mismo instante. */
const STAGGER_MS = 400;
/** Techo de la precarga inicial: mas que esto ya es demasiada espera de entrada. */
const PRELOAD_CAP = 24;
/** Red de contencion: si igual se vacia, rellena por atras sin frenar el juego. */
const REFILL_AT = 8;

let counter = 0;
function questionId(): string {
  counter += 1;
  return `q${Date.now().toString(36)}-${counter}`;
}

/** Para descartar repetidas: dos enunciados que solo difieren en tildes son el mismo. */
function fingerprint(prompt: string): string {
  return prompt
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export interface DeckOptions {
  brief: string;
  difficulty: Difficulty;
  /** Se llama cada vez que entran preguntas nuevas, para poder mostrar el avance. */
  onProgress?: (ready: number) => void;
}

export class Deck {
  private queue: Question[] = [];
  private asked: string[] = [];
  private seen = new Set<string>();
  private feedback: string[] = [];
  private filling: Promise<void> | null = null;
  /** Cuantas preguntas necesita la partida en total. Sin esto el mazo se
   *  rellenaria para siempre, gastando cuota en preguntas que nadie va a ver. */
  private target = Number.POSITIVE_INFINITY;
  /** Sube en cada correccion; sirve para descartar tandas que quedaron viejas. */
  private generation = 0;

  constructor(
    private client: AiClient,
    private options: DeckOptions,
  ) {}

  get pending(): number {
    return this.queue.length;
  }

  get corrections(): string[] {
    return [...this.feedback];
  }

  /**
   * Prepara de una vez todas las preguntas de la partida.
   *
   * Los pedidos van en paralelo porque tres de ocho tardan mucho menos que uno
   * de veinticuatro, y esta espera es la unica que el jugador va a ver.
   */
  async preload(rounds: number): Promise<void> {
    this.target = rounds;
    const goal = Math.min(rounds, PRELOAD_CAP);

    // La revision descarta preguntas y los pedidos en paralelo a veces se pisan,
    // asi que la primera vuelta puede quedar corta. Se completa aca, mientras el
    // jugador todavia esta mirando la pantalla de carga, y no en medio del juego.
    for (let round = 0; round < 3; round += 1) {
      const missing = goal - this.queue.length;
      if (missing <= 0) return;
      const before = this.queue.length;

      try {
        await this.fill(missing, round === 0 ? PARALLEL : 1);
      } catch (error) {
        // Con preguntas en la mano se arranca igual: mejor una partida de doce
        // que un cartel de error. Solo si el mazo quedo vacio se avisa.
        if (this.queue.length) return;
        throw error;
      }

      // Si una vuelta no sumo nada, insistir es perder el tiempo del jugador.
      if (this.queue.length === before) return;
    }
  }

  /** Cuantas faltan para completar la partida, contando lo ya servido. */
  private get missing(): number {
    return this.target - this.asked.length - this.queue.length;
  }

  /**
   * Una correccion de la mesa ("estan muy dificiles") tiene que verse en la
   * proxima pregunta, no dentro de ocho. Por eso tira a la basura lo precargado.
   */
  correct(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.feedback.push(clean);
    this.discard();
  }

  setDifficulty(difficulty: Difficulty): void {
    if (difficulty === this.options.difficulty) return;
    this.options = { ...this.options, difficulty };
    this.discard();
  }

  private discard(): void {
    this.queue = [];
    this.generation += 1;
    this.filling = null;
    this.options.onProgress?.(0);
  }

  /** Saca la proxima pregunta. Con el mazo precargado no espera nada. */
  async take(): Promise<Question> {
    if (!this.queue.length) {
      await this.fill(Math.max(1, Math.min(PER_REQUEST, this.missing)), 1);
    }

    const question = this.queue.shift();
    if (!question) throw new Error('El generador no devolvió ninguna pregunta.');
    this.asked.push(question.prompt);

    this.prime();
    return question;
  }

  /** Rellena por atras si el mazo quedo flaco. Se puede llamar de mas. */
  prime(): void {
    if (this.queue.length >= REFILL_AT || this.filling) return;
    // Ni una pregunta mas de las que la partida va a usar.
    const needed = Math.min(PER_REQUEST, this.missing);
    if (needed <= 0) return;
    void this.fill(needed, 1).catch(() => {
      // Un fallo de precarga no rompe nada: cuando toque `take` se reintenta y
      // ahi si el error llega a la pantalla.
    });
  }

  /** Pide `count` preguntas repartidas en hasta `parallel` pedidos simultaneos. */
  private fill(count: number, parallel: number): Promise<void> {
    if (this.filling) return this.filling;

    const generation = this.generation;
    const run = (async () => {
      const sizes = splitEvenly(count, parallel);
      const rounds = await Promise.allSettled(
        sizes.map(async (size, index) => {
          if (index > 0) await new Promise((resolve) => setTimeout(resolve, index * STAGGER_MS));
          return this.requestBatch(size);
        }),
      );
      if (generation !== this.generation) return;

      for (const round of rounds) {
        if (round.status === 'fulfilled') this.absorb(round.value);
      }

      // Solo es un error si nos quedamos sin nada que servir. Si entro aunque sea
      // una tanda, la partida arranca igual y el resto se completa por atras.
      const failure = rounds.find((round) => round.status === 'rejected');
      if (!this.queue.length && failure?.status === 'rejected') throw failure.reason;
    })();

    // Ojo: `finally` devuelve una promesa NUEVA, hay que comparar contra esa.
    const wrapped: Promise<void> = run.finally(() => {
      if (this.filling === wrapped) this.filling = null;
    });
    this.filling = wrapped;
    return wrapped;
  }

  private async requestBatch(count: number): Promise<Question[]> {
    const result = await this.client.generate({
      brief: this.options.brief,
      difficulty: this.options.difficulty,
      count,
      // Evitamos lo ya jugado y lo que espera en la cola. Los pedidos que salen
      // juntos no se ven entre si, y por eso existe el filtro de repetidas.
      avoid: [...this.asked, ...this.queue.map((q) => q.prompt)],
      feedback: this.feedback,
    });
    return result.questions.map((q) => ({ ...q, id: questionId() }) as Question);
  }

  private absorb(questions: Question[]): void {
    for (const question of questions) {
      const key = fingerprint(question.prompt);
      if (!key || this.seen.has(key)) continue;
      this.seen.add(key);
      this.queue.push(question);
    }
    this.options.onProgress?.(this.queue.length);
  }
}

/**
 * Reparte `total` en pedidos que salen juntos.
 *
 * Apunta a `parts` pedidos porque lo que se espera es el mas lento de todos:
 * tres de siete terminan antes que dos de diez. Los limites son el techo por
 * pedido (uno gigante tarda demasiado) y un piso (uno de una sola pregunta no
 * vale el viaje).
 */
export function splitEvenly(total: number, parts: number): number[] {
  const floorByCap = Math.max(1, Math.ceil(total / PER_REQUEST));
  const ceilByFloor = Math.max(floorByCap, Math.floor(total / MIN_PER_REQUEST));
  const count = Math.min(Math.max(parts, floorByCap), ceilByFloor);
  const base = Math.floor(total / count);
  const extra = total % count;
  return Array.from({ length: count }, (_, i) =>
    Math.max(1, Math.min(PER_REQUEST, base + (i < extra ? 1 : 0))),
  );
}
