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

/** Un pedido mas grande que esto no lo acepta el contrato. */
const PER_REQUEST = LIMITS.maxCount;
/**
 * La primera tanda es corta a proposito: es la unica que frena el arranque.
 * Cinco preguntas son varios minutos de mesa, de sobra para que llegue el resto.
 */
const FIRST_BATCH = 5;
/** Y uno mas chico que esto no vale el viaje: mejor sumarlo a otro. */
const MIN_PER_REQUEST = 3;
/** Separacion entre pedidos simultaneos, para no golpear el cupo todos juntos. */
const STAGGER_MS = 400;
/** Techo de la precarga inicial. Lo que pase de aca entra jugando. */
const PRELOAD_CAP = 20;
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
  /** El ultimo error de una tanda, para poder contarlo si no queda ninguna. */
  private lastError: unknown = null;
  /** Quienes estan esperando que entre la primera pregunta. */
  private waiters: (() => void)[] = [];
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
   * Prepara el mazo, pero solo hace esperar por las primeras.
   *
   * Todas las tandas salen juntas al empezar. La partida arranca apenas llega la
   * primera —cinco preguntas son varios minutos de mesa— y las demas van
   * entrando mientras se juegan esas. Esperar el mazo completo eran cuarenta
   * segundos largos de pantalla de carga, y no hacen falta para nada.
   */
  async preload(rounds: number): Promise<void> {
    this.target = rounds;
    const sizes = planBatches(Math.min(rounds, PRELOAD_CAP));
    const jobs = this.launch(sizes);

    const everything = Promise.allSettled(jobs).then(() => undefined);
    this.track(everything);

    // Alcanza con que entre la primera tanda, sea cual sea: si la corta se cayo
    // pero la grande llego, se juega igual.
    await this.anyQuestion(everything);
    if (!this.queue.length) {
      throw this.lastError ?? new Error('No se pudieron preparar las preguntas.');
    }
  }

  /**
   * Espera hasta que haya al menos una pregunta servible, o hasta que se acabe
   * el trabajo en curso. Nunca espera el mazo completo: esa era la diferencia
   * entre arrancar en cuatro segundos y arrancar en trece.
   */
  private anyQuestion(work: Promise<void>): Promise<unknown> {
    if (this.queue.length) return Promise.resolve();
    const first = new Promise<void>((resolve) => this.waiters.push(resolve));
    return Promise.race([first, work]);
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
    this.releaseWaiters();
    this.options.onProgress?.(0);
  }

  /** Saca la proxima pregunta. Con el mazo precargado no espera nada. */
  async take(): Promise<Question> {
    // Si el mazo esta vacio pero hay tandas en camino, se espera a la primera
    // que llegue antes de salir a pedir mas: pedir de mas es lo que hace saltar
    // el cupo, y esperar el mazo entero es lo que hacia eterno el arranque.
    if (!this.queue.length && this.filling) {
      await this.anyQuestion(this.filling.catch(() => undefined));
    }
    if (!this.queue.length) {
      await this.fillOne(Math.max(1, Math.min(PER_REQUEST, this.missing)));
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
    void this.fillOne(needed).catch(() => {
      // Un fallo de precarga no rompe nada: cuando toque `take` se reintenta y
      // ahi si el error llega a la pantalla.
    });
  }

  /**
   * Lanza las tandas y devuelve una promesa por cada una, para poder esperar
   * solo la primera. Van escalonadas para no golpear el cupo todas juntas.
   */
  private launch(sizes: number[]): Promise<void>[] {
    const generation = this.generation;
    return sizes.map(async (size, index) => {
      try {
        if (index > 0) {
          await new Promise((resolve) => setTimeout(resolve, index * STAGGER_MS));
        }
        const questions = await this.requestBatch(size);
        // Si mientras tanto la mesa pidio una correccion, esta tanda ya no sirve.
        if (generation !== this.generation) return;
        this.absorb(questions);
      } catch (error) {
        this.lastError = error;
        throw error;
      }
    });
  }

  /** Deja anotado que hay trabajo en curso, y lo borra al terminar. */
  private track(work: Promise<void>): Promise<void> {
    this.filling = work;
    const clear = () => {
      if (this.filling === work) this.filling = null;
      // Nadie mas va a traer preguntas: soltamos a los que esperaban.
      this.releaseWaiters();
    };
    // Con los dos handlers puestos, un fallo no queda como rechazo sin atender.
    void work.then(clear, clear);
    return work;
  }

  /** Una sola tanda, para rellenar por atras. */
  private fillOne(count: number): Promise<void> {
    if (this.filling) return this.filling;
    return this.track(this.launch([count])[0]);
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
    const before = this.queue.length;
    for (const question of questions) {
      const key = fingerprint(question.prompt);
      if (!key || this.seen.has(key)) continue;
      this.seen.add(key);
      this.queue.push(question);
    }
    this.options.onProgress?.(this.queue.length);
    if (this.queue.length > before) this.releaseWaiters();
  }

  private releaseWaiters(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }
}

/**
 * Como se reparte el mazo inicial: una tanda corta primero y el resto detras.
 *
 * La primera es la unica que frena el arranque, asi que se la deja chica. Las
 * que siguen son grandes porque nadie las espera mirando la pantalla, y cuantas
 * menos sean, menos cupo se gasta.
 */
export function planBatches(total: number): number[] {
  const first = Math.min(FIRST_BATCH, total);
  const rest = total - first;
  if (rest <= 0) return [first];
  return [first, ...splitEvenly(rest, Math.ceil(rest / PER_REQUEST))];
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
