/**
 * El mazo de preguntas.
 *
 * Nunca genera de a una: pide tandas y va precargando la siguiente mientras la
 * mesa juega, para que entre pregunta y pregunta no haya pantalla de carga. Es
 * tambien el que recuerda que salio ya y que correcciones fue pidiendo la mesa.
 */

import type { Difficulty } from '../shared/contracts';
import type { Question } from '../game/types';
import type { AiClient } from './transport';

/** Primera tanda corta para que la partida arranque rapido; despues, mas largas. */
const FIRST_BATCH = 4;
const BATCH = 8;
/** Cuando quedan estas o menos, salimos a buscar mas. */
const REFILL_AT = 3;

let counter = 0;
function questionId(): string {
  counter += 1;
  return `q${Date.now().toString(36)}-${counter}`;
}

export interface DeckOptions {
  brief: string;
  difficulty: Difficulty;
}

export class Deck {
  private queue: Question[] = [];
  private asked: string[] = [];
  private feedback: string[] = [];
  private inflight: Promise<void> | null = null;
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
   * Una correccion de la mesa ("estan muy dificiles") tiene que verse en la
   * proxima pregunta, no dentro de ocho. Por eso tira a la basura lo precargado.
   */
  correct(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.feedback.push(clean);
    this.queue = [];
    this.generation += 1;
    this.inflight = null;
  }

  setDifficulty(difficulty: Difficulty): void {
    if (difficulty === this.options.difficulty) return;
    this.options = { ...this.options, difficulty };
    this.queue = [];
    this.generation += 1;
    this.inflight = null;
  }

  /** Saca la proxima pregunta, esperando la tanda solo si hace falta. */
  async take(): Promise<Question> {
    if (!this.queue.length) await this.fetchBatch(this.asked.length ? BATCH : FIRST_BATCH);

    const question = this.queue.shift();
    if (!question) throw new Error('El generador no devolvió ninguna pregunta.');
    this.asked.push(question.prompt);

    // Y salimos a buscar mas sin bloquear a nadie.
    this.prime();
    return question;
  }

  /** Dispara la precarga si el mazo esta flaco. Se puede llamar de mas. */
  prime(): void {
    if (this.queue.length > REFILL_AT || this.inflight) return;
    void this.fetchBatch(BATCH).catch(() => {
      // Un fallo de precarga no rompe nada: cuando toque `take` se reintenta y
      // ahi si el error llega a la pantalla.
    });
  }

  private fetchBatch(count: number): Promise<void> {
    if (this.inflight) return this.inflight;

    const generation = this.generation;
    const run = (async () => {
      const result = await this.client.generate({
        brief: this.options.brief,
        difficulty: this.options.difficulty,
        count,
        // Evitamos tanto lo ya jugado como lo que espera en la cola.
        avoid: [...this.asked, ...this.queue.map((q) => q.prompt)],
        feedback: this.feedback,
      });

      // Si mientras tanto la mesa pidio una correccion, esta tanda ya no sirve.
      if (generation !== this.generation) return;
      this.queue.push(
        ...result.questions.map((q) => ({ ...q, id: questionId() }) as Question),
      );
    })();

    // Ojo con esto: `finally` devuelve una promesa NUEVA. Comparar contra `run`
    // en vez de contra la envuelta dejaba `inflight` colgado para siempre, y el
    // mazo no volvia a recargarse nunca mas despues de la primera tanda.
    const wrapped: Promise<void> = run.finally(() => {
      if (this.inflight === wrapped) this.inflight = null;
    });
    this.inflight = wrapped;
    return wrapped;
  }
}
