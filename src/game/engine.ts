/**
 * Motor del juego: una funcion pura `reduce(state, action)`.
 *
 * No toca React, ni la red, ni el reloj del sistema. Todo lo que pasa en una
 * partida entra por una accion, asi que el dia que se juegue en varios
 * telefonos alcanza con transportar acciones por la red y correr este mismo
 * reducer en cada dispositivo.
 */

import type { Verdict } from '../shared/contracts';
import {
  DEFAULT_SETTINGS,
  type GameSettings,
  type GameState,
  type Player,
  type PlayerId,
  type Question,
  type RoundRecord,
} from './types';

export type Action =
  | { type: 'start'; players: Player[]; settings: GameSettings }
  /** La capa de datos entrego la proxima pregunta. */
  | { type: 'questionReady'; question: Question }
  /** El jugador mando su respuesta (modo IA). */
  | { type: 'answer'; given: string }
  /** Llego el veredicto: de la IA, del boton manual, o del cronometro. */
  | { type: 'verdict'; verdict: Verdict; reason?: string }
  /** El de turno se rinde: cuenta como incorrecta y habilita el robo. */
  | { type: 'giveUp' }
  /** Alguien aprieta el boton de robo (modo manual: resuelve directo). */
  | { type: 'stealAnswer'; given: string }
  | { type: 'stealVerdict'; verdict: Verdict; reason?: string }
  /** Se cerro la ventana de robo sin que nadie la use. */
  | { type: 'stealPass' }
  /** Pasar a la proxima pregunta. */
  | { type: 'next' }
  | { type: 'reset' };

export function emptyState(): GameState {
  return {
    players: [],
    settings: { ...DEFAULT_SETTINGS },
    scores: {},
    turnIndex: 0,
    questionNumber: 0,
    phase: 'idle',
    current: null,
    given: null,
    verdict: null,
    reason: null,
    stealTo: null,
    stealGiven: null,
    delta: {},
    history: [],
  };
}

function zeroed(players: Player[]): Record<PlayerId, number> {
  return Object.fromEntries(players.map((p) => [p.id, 0]));
}

/** Quien tiene derecho a robar: el siguiente en la ronda. En 1vs1 es el rival. */
function nextPlayerId(state: GameState): PlayerId | null {
  if (state.players.length < 2) return null;
  return state.players[(state.turnIndex + 1) % state.players.length].id;
}

function award(state: GameState, playerId: PlayerId, points: number): GameState {
  if (points === 0) return state;
  return {
    ...state,
    scores: { ...state.scores, [playerId]: (state.scores[playerId] ?? 0) + points },
    delta: { ...state.delta, [playerId]: (state.delta[playerId] ?? 0) + points },
  };
}

/**
 * Cierra la ronda: la guarda en el historial y decide si la partida sigue.
 * Se llama cuando ya no queda nada por resolver (ni robo pendiente).
 */
function closeRound(state: GameState, stolenBy: PlayerId | null): GameState {
  if (!state.current || !state.verdict) return state;
  const record: RoundRecord = {
    question: state.current,
    askedTo: state.players[state.turnIndex].id,
    given: state.given,
    verdict: state.verdict,
    stolenBy,
    points: state.delta,
  };
  return { ...state, phase: 'reveal', history: [...state.history, record] };
}

export function reduce(state: GameState, action: Action): GameState {
  switch (action.type) {
    case 'start': {
      return {
        ...emptyState(),
        players: action.players,
        settings: action.settings,
        scores: zeroed(action.players),
        delta: zeroed(action.players),
        questionNumber: 1,
        phase: 'waiting',
      };
    }

    case 'questionReady': {
      if (state.phase !== 'waiting') return state;
      return { ...state, current: action.question, phase: 'asking' };
    }

    case 'answer': {
      if (state.phase !== 'asking') return state;
      // En modo manual nadie escribe: el veredicto llega por boton.
      if (state.settings.judgeMode !== 'ia') return state;
      return { ...state, given: action.given, phase: 'judging' };
    }

    case 'giveUp': {
      if (state.phase !== 'asking') return state;
      return reduce({ ...state, given: state.given ?? '' }, {
        type: 'verdict',
        verdict: 'incorrecta',
        reason: 'Se rindio',
      });
    }

    case 'verdict': {
      if (state.phase !== 'asking' && state.phase !== 'judging') return state;
      const asked = state.players[state.turnIndex];
      let next: GameState = {
        ...state,
        verdict: action.verdict,
        reason: action.reason ?? null,
        delta: zeroed(state.players),
      };

      if (action.verdict === 'correcta') {
        next = award(next, asked.id, state.settings.pointCorrect);
        return closeRound(next, null);
      }

      if (action.verdict === 'parcial') {
        // Media respuesta ya vale medio punto, y no se abre el robo: la mesa
        // escucho lo suficiente como para que robar sea regalado.
        next = award(next, asked.id, state.settings.pointPartial);
        return closeRound(next, null);
      }

      // Incorrecta: se abre la ventana de robo, si esta habilitada.
      const thief = state.settings.stealSeconds > 0 ? nextPlayerId(state) : null;
      if (!thief) return closeRound(next, null);
      return { ...next, phase: 'steal', stealTo: thief };
    }

    case 'stealPass': {
      if (state.phase !== 'steal') return state;
      return closeRound({ ...state, stealTo: null }, null);
    }

    case 'stealAnswer': {
      if (state.phase !== 'steal') return state;
      if (state.settings.judgeMode !== 'ia') return state;
      return { ...state, stealGiven: action.given, phase: 'stealJudging' };
    }

    case 'stealVerdict': {
      if (state.phase !== 'steal' && state.phase !== 'stealJudging') return state;
      const thief = state.stealTo;
      if (!thief) return state;
      // Un robo parcial no alcanza: o sabias la respuesta o no la sabias.
      if (action.verdict !== 'correcta') {
        return closeRound({ ...state, stealTo: null }, null);
      }
      const next = award(state, thief, state.settings.pointSteal);
      return closeRound({ ...next, stealTo: null }, thief);
    }

    case 'next': {
      if (state.phase !== 'reveal') return state;
      if (state.questionNumber >= state.settings.rounds) {
        return { ...state, phase: 'over' };
      }
      return {
        ...state,
        phase: 'waiting',
        turnIndex: (state.turnIndex + 1) % state.players.length,
        questionNumber: state.questionNumber + 1,
        current: null,
        given: null,
        verdict: null,
        reason: null,
        stealTo: null,
        stealGiven: null,
        delta: zeroed(state.players),
      };
    }

    case 'reset':
      return emptyState();

    default:
      return state;
  }
}

/** Enunciados ya usados, para pedirle al generador que no repita. */
export function askedPrompts(state: GameState): string[] {
  const used = state.history.map((r) => r.question.prompt);
  if (state.current) used.push(state.current.prompt);
  return used;
}

export interface Standing {
  player: Player;
  score: number;
  position: number;
}

/** Tabla final ordenada, con empates compartiendo posicion. */
export function standings(state: GameState): Standing[] {
  const sorted = [...state.players].sort(
    (a, b) => (state.scores[b.id] ?? 0) - (state.scores[a.id] ?? 0),
  );
  let position = 0;
  let previous: number | null = null;
  return sorted.map((player, index) => {
    const score = state.scores[player.id] ?? 0;
    if (score !== previous) {
      position = index + 1;
      previous = score;
    }
    return { player, score, position };
  });
}

/** True si nadie quedo solo en el primer puesto. */
export function isTie(state: GameState): boolean {
  const table = standings(state);
  return table.length > 1 && table[0].score === table[1].score;
}
