import type { Difficulty, GeneratedQuestion, Verdict } from '../shared/contracts';

export type PlayerId = string;

export interface Player {
  id: PlayerId;
  name: string;
  /** Indice en la paleta de jugadores; define color y patron. */
  skin: number;
}

export type JudgeMode = 'ia' | 'manual';

export interface GameSettings {
  /** Quien decide si la respuesta estuvo bien. */
  judgeMode: JudgeMode;
  /** Segundos por pregunta, o null para jugar sin reloj. */
  timerSeconds: number | null;
  /** Ventana de robo. 0 desactiva el robo. */
  stealSeconds: number;
  /** Cuantas preguntas dura la partida. */
  rounds: number;
  /** Puntaje. Se deja configurable porque cada mesa lo acuerda distinto. */
  pointCorrect: number;
  pointPartial: number;
  pointSteal: number;
  /** Pedido en lenguaje natural y nivel, para el generador. */
  brief: string;
  difficulty: Difficulty;
}

export const DEFAULT_SETTINGS: GameSettings = {
  // IA por defecto: es el unico modo que funciona con dos jugadores y un solo
  // telefono, sin que nadie vea la respuesta antes de tiempo.
  judgeMode: 'ia',
  timerSeconds: null,
  stealSeconds: 7,
  rounds: 20,
  pointCorrect: 1,
  pointPartial: 0.5,
  pointSteal: 0.5,
  brief: '',
  difficulty: 'normal',
};

export interface Question extends GeneratedQuestion {
  id: string;
}

/**
 * Fases de una pregunta. El motor no sabe de pantallas: la UI mapea cada fase
 * a lo que muestra.
 */
export type Phase =
  | 'idle' // todavia no empezo
  | 'waiting' // el motor pide una pregunta y nadie se la dio aun
  | 'asking' // pregunta en pantalla, el de turno esta respondiendo
  | 'judging' // esperando el veredicto de la IA
  | 'steal' // ventana de robo abierta
  | 'stealJudging'
  | 'reveal' // se muestra la respuesta y lo que paso
  | 'over';

export interface RoundRecord {
  question: Question;
  askedTo: PlayerId;
  given: string | null;
  verdict: Verdict;
  /** Quien robo, si alguien robo y acerto. */
  stolenBy: PlayerId | null;
  points: Record<PlayerId, number>;
}

export interface GameState {
  players: Player[];
  settings: GameSettings;
  scores: Record<PlayerId, number>;
  /** Indice en `players` del jugador al que le toca. */
  turnIndex: number;
  /** Numero de pregunta en curso, 1-based. */
  questionNumber: number;
  phase: Phase;
  current: Question | null;
  /** Lo que el jugador contesto en la ronda en curso (modo IA). */
  given: string | null;
  verdict: Verdict | null;
  /** Motivo que dio el arbitro IA, para mostrar en el reveal. */
  reason: string | null;
  /** A quien le toca la chance de robar, si la ventana esta abierta. */
  stealTo: PlayerId | null;
  stealGiven: string | null;
  /** Puntos que se sumaron en la ronda en curso, para animar el marcador. */
  delta: Record<PlayerId, number>;
  history: RoundRecord[];
}
