import { describe, expect, it } from 'vitest';
import { askedPrompts, emptyState, isTie, reduce, standings, type Action } from './engine';
import { DEFAULT_SETTINGS, type GameSettings, type GameState, type Player, type Question } from './types';

const ANTONIO: Player = { id: 'a', name: 'Antonio', skin: 0 };
const ALEXIS: Player = { id: 'b', name: 'Alexis', skin: 1 };

function question(n: number): Question {
  return {
    id: `q${n}`,
    prompt: `Pregunta ${n}`,
    answer: `Respuesta ${n}`,
    accept: [],
    topic: 'test',
    difficulty: 'normal',
  };
}

function play(actions: Action[], settings: Partial<GameSettings> = {}): GameState {
  const start: Action = {
    type: 'start',
    players: [ANTONIO, ALEXIS],
    settings: { ...DEFAULT_SETTINGS, rounds: 4, ...settings },
  };
  return [start, ...actions].reduce(reduce, emptyState());
}

describe('flujo basico de una ronda', () => {
  it('arranca esperando la primera pregunta', () => {
    const s = play([]);
    expect(s.phase).toBe('waiting');
    expect(s.questionNumber).toBe(1);
    expect(s.scores).toEqual({ a: 0, b: 0 });
  });

  it('acertar suma un punto entero y cierra la ronda sin robo', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'correcta' },
    ]);
    expect(s.scores.a).toBe(1);
    expect(s.phase).toBe('reveal');
    expect(s.history).toHaveLength(1);
  });

  it('una respuesta parcial paga medio punto y tampoco abre el robo', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'parcial' },
    ]);
    expect(s.scores.a).toBe(0.5);
    expect(s.phase).toBe('reveal');
  });

  it('el turno rota recien al pasar de pregunta', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'correcta' },
      { type: 'next' },
    ]);
    expect(s.turnIndex).toBe(1);
    expect(s.questionNumber).toBe(2);
    expect(s.phase).toBe('waiting');
    expect(s.current).toBeNull();
  });
});

describe('el robo', () => {
  it('fallar abre la ventana para el rival', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'incorrecta' },
    ]);
    expect(s.phase).toBe('steal');
    expect(s.stealTo).toBe('b');
  });

  it('rendirse tambien abre la ventana', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'giveUp' },
    ]);
    expect(s.phase).toBe('steal');
    expect(s.stealTo).toBe('b');
  });

  it('robar bien paga medio punto al ladron y queda registrado', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'incorrecta' },
      { type: 'stealVerdict', verdict: 'correcta' },
    ]);
    expect(s.scores).toEqual({ a: 0, b: 0.5 });
    expect(s.history[0].stolenBy).toBe('b');
    expect(s.phase).toBe('reveal');
  });

  it('robar mal no suma ni resta', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'incorrecta' },
      { type: 'stealVerdict', verdict: 'incorrecta' },
    ]);
    expect(s.scores).toEqual({ a: 0, b: 0 });
    expect(s.history[0].stolenBy).toBeNull();
  });

  it('un robo a medias no paga: o sabias o no sabias', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'incorrecta' },
      { type: 'stealVerdict', verdict: 'parcial' },
    ]);
    expect(s.scores.b).toBe(0);
  });

  it('dejar pasar la ventana cierra la ronda', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'incorrecta' },
      { type: 'stealPass' },
    ]);
    expect(s.phase).toBe('reveal');
    expect(s.stealTo).toBeNull();
  });

  it('con el robo apagado se salta la ventana', () => {
    const s = play(
      [
        { type: 'questionReady', question: question(1) },
        { type: 'verdict', verdict: 'incorrecta' },
      ],
      { stealSeconds: 0 },
    );
    expect(s.phase).toBe('reveal');
  });
});

describe('modo arbitro IA', () => {
  it('mandar respuesta deja la ronda esperando el veredicto', () => {
    const s = play(
      [
        { type: 'questionReady', question: question(1) },
        { type: 'answer', given: 'Messi' },
      ],
      { judgeMode: 'ia' },
    );
    expect(s.phase).toBe('judging');
    expect(s.given).toBe('Messi');
  });

  it('en modo manual escribir una respuesta no hace nada', () => {
    const s = play(
      [
        { type: 'questionReady', question: question(1) },
        { type: 'answer', given: 'Messi' },
      ],
      { judgeMode: 'manual' },
    );
    expect(s.phase).toBe('asking');
    expect(s.given).toBeNull();
  });

  it('el veredicto de la IA guarda el motivo para mostrarlo', () => {
    const s = play(
      [
        { type: 'questionReady', question: question(1) },
        { type: 'answer', given: 'messi' },
        { type: 'verdict', verdict: 'correcta', reason: 'Es el apellido, alcanza' },
      ],
      { judgeMode: 'ia' },
    );
    expect(s.reason).toBe('Es el apellido, alcanza');
    expect(s.scores.a).toBe(1);
  });
});

describe('fin de partida', () => {
  const win: Action[] = [
    { type: 'questionReady', question: question(1) },
    { type: 'verdict', verdict: 'correcta' },
  ];

  it('termina al agotar las rondas configuradas', () => {
    let s = play(win, { rounds: 2 });
    s = reduce(s, { type: 'next' });
    s = [
      { type: 'questionReady', question: question(2) } as Action,
      { type: 'verdict', verdict: 'incorrecta' } as Action,
      { type: 'stealPass' } as Action,
      { type: 'next' } as Action,
    ].reduce(reduce, s);
    expect(s.phase).toBe('over');
  });

  it('la tabla ordena por puntaje y comparte posicion en el empate', () => {
    const s = play(win);
    const table = standings(s);
    expect(table[0].player.id).toBe('a');
    expect(table[0].position).toBe(1);
    expect(isTie(s)).toBe(false);

    const tied = play([]);
    expect(isTie(tied)).toBe(true);
    expect(standings(tied).map((r) => r.position)).toEqual([1, 1]);
  });
});

describe('anti repeticion', () => {
  it('junta los enunciados ya usados, incluido el que esta en pantalla', () => {
    const s = play([
      { type: 'questionReady', question: question(1) },
      { type: 'verdict', verdict: 'correcta' },
      { type: 'next' },
      { type: 'questionReady', question: question(2) },
    ]);
    expect(askedPrompts(s)).toEqual(['Pregunta 1', 'Pregunta 2']);
  });
});

describe('acciones fuera de fase', () => {
  it('se ignoran en vez de romper el estado', () => {
    const s = play([
      { type: 'next' },
      { type: 'verdict', verdict: 'correcta' },
      { type: 'stealVerdict', verdict: 'correcta' },
    ]);
    expect(s.phase).toBe('waiting');
    expect(s.scores).toEqual({ a: 0, b: 0 });
  });
});
