import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { emptyState, reduce } from '../game/engine';
import type { GameSettings, Player } from '../game/types';
import type { Verdict } from '../shared/contracts';
import { AiError } from '../shared/providers';
import { Deck } from '../ai/deck';
import { createAiClient } from '../ai/transport';
import type { AppSettings } from '../state/settings';
import { Button, Sheet } from '../ui/controls';
import { Dots, Scoreboard, TimerBar, useCountdown } from '../ui/game-bits';
import { fx } from '../ui/feedback';
import { tintFor } from '../ui/palette';
import { useSpeech } from '../ui/useSpeech';
import { ResultsScreen } from './Results';

interface Props {
  settings: AppSettings;
  onPatch: (changes: Partial<AppSettings>) => void;
  players: Player[];
  game: GameSettings;
  onExit: () => void;
  onRematch: () => void;
}

/** Correcciones de un toque. Son las que mas se repiten en una juntada. */
const QUICK_FIXES = [
  'Están muy difíciles, bajá el nivel',
  'Están muy fáciles, subí el nivel',
  'Menos geografía y capitales',
  'Más de fútbol argentino',
  'Menos fechas y años',
  'Preguntas más cortas',
];

function humanError(error: unknown): string {
  if (error instanceof AiError) {
    switch (error.code) {
      case 'unauthorized':
        return 'La API key no sirve o venció. Revisala en Ajustes.';
      case 'rate_limited':
        return 'El proveedor te frenó por exceso de pedidos. Esperá un minuto y reintentá.';
      case 'overloaded':
      case 'model_missing':
        return error.message;
      case 'not_configured':
        return 'Falta configurar la conexión con la IA, en Ajustes.';
      case 'refusal':
        return error.message;
      case 'bad_output':
        return 'La IA devolvió algo que no se entiende. Reintentá.';
      case 'timeout':
        return 'La IA tardó demasiado.';
      default:
        return error.message;
    }
  }
  return (error as Error)?.message ?? 'Algo salió mal.';
}

export function PlayScreen({ settings, onPatch, players, game, onExit, onRematch }: Props) {
  const [state, dispatch] = useReducer(reduce, undefined, emptyState);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [answer, setAnswer] = useState('');
  const [showAnswer, setShowAnswer] = useState(false);
  const [tuning, setTuning] = useState(false);
  const [tuneText, setTuneText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [ready, setReady] = useState(0);
  /** El arbitro no contesto: en vez de colgar la partida, decide la mesa. */
  const [judgeDown, setJudgeDown] = useState(false);

  // El cliente lee los ajustes por referencia, asi no se recrea en cada cambio y
  // el mazo puede quedarse con el mismo durante toda la partida.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const noteModelSwitch = useCallback(
    (model: string) => {
      // Una misma tanda puede cambiar de modelo en varias llamadas seguidas
      // (generar y revisar son dos), y no hace falta avisarlo dos veces.
      if (settingsRef.current.model === model) return;
      onPatch({ model });
      setToast(`El modelo estaba saturado. Seguimos con ${model}.`);
      window.setTimeout(() => setToast(null), 3600);
    },
    [onPatch],
  );

  const client = useMemo(
    () => createAiClient(() => settingsRef.current, noteModelSwitch),
    [noteModelSwitch],
  );

  const deck = useRef<Deck | null>(null);
  if (!deck.current) {
    deck.current = new Deck(client, {
      brief: game.brief,
      difficulty: game.difficulty,
      onProgress: setReady,
    });
  }

  // Arranque de la partida. Solo una vez: la revancha remonta el componente.
  //
  // El mazo entero se prepara aca, de una: la mesa banca esperar al empezar,
  // pero no que el juego se frene cada ocho preguntas.
  useEffect(() => {
    dispatch({ type: 'start', players, settings: game });
    void deck.current?.preload(game.rounds).catch(() => {
      // El error real se muestra cuando `take` lo vuelva a intentar.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Cada vez que el motor queda esperando, le servimos la proxima pregunta.
  useEffect(() => {
    if (state.phase !== 'waiting') return undefined;
    let cancelled = false;
    setError(null);
    setAnswer('');
    setShowAnswer(false);
    deck.current
      ?.take()
      .then((question) => {
        if (!cancelled) dispatch({ type: 'questionReady', question });
      })
      .catch((cause) => {
        if (!cancelled) setError(humanError(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.questionNumber, retry]);

  // Veredicto de la IA, tanto para la respuesta del turno como para el robo.
  useEffect(() => {
    const stealing = state.phase === 'stealJudging';
    if (state.phase !== 'judging' && !stealing) return undefined;
    const question = state.current;
    if (!question) return undefined;

    let cancelled = false;
    setError(null);
    setJudgeDown(false);
    client
      .judge({
        question: question.prompt,
        answer: question.answer,
        accept: question.accept,
        given: (stealing ? state.stealGiven : state.given) ?? '',
      })
      .then((result) => {
        if (cancelled) return;
        dispatch(
          stealing
            ? { type: 'stealVerdict', verdict: result.verdict, reason: result.reason }
            : { type: 'verdict', verdict: result.verdict, reason: result.reason },
        );
      })
      .catch(() => {
        // Un arbitro caido no puede frenar la mesa: se pasa a decision manual.
        if (!cancelled) setJudgeDown(true);
      });
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.current, state.given, state.stealGiven, client]);

  // El robo comparte el campo de texto con el turno normal, asi que hay que
  // vaciarlo al abrir la ventana: si no, el ladron encuentra escrita la
  // respuesta que acaba de errar el otro.
  useEffect(() => {
    if (state.phase === 'steal') setAnswer('');
  }, [state.phase]);

  // Sonido al cerrar cada ronda: es lo que le da cuerpo al acierto y al error.
  const closedAt = useRef(-1);
  useEffect(() => {
    if (state.phase !== 'reveal' || state.questionNumber === closedAt.current) return;
    closedAt.current = state.questionNumber;
    const last = state.history[state.history.length - 1];
    if (!last) return;
    if (last.stolenBy) fx.steal();
    else if (last.verdict === 'correcta') fx.correct();
    else if (last.verdict === 'parcial') fx.partial();
    else fx.wrong();
  }, [state.phase, state.questionNumber, state.history]);

  const asker = state.players[state.turnIndex] ?? players[0];
  const thief = state.players.find((p) => p.id === state.stealTo) ?? null;

  const timeUp = useCallback(() => {
    dispatch({ type: 'verdict', verdict: 'incorrecta', reason: 'Se acabó el tiempo' });
  }, []);
  const timer = useCountdown(game.timerSeconds, state.phase === 'asking', timeUp);

  const stealOver = useCallback(() => dispatch({ type: 'stealPass' }), []);
  const stealClock = useCountdown(game.stealSeconds || null, state.phase === 'steal', stealOver);

  const speech = useSpeech(setAnswer);

  const applyTuning = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    deck.current?.correct(clean);
    setTuning(false);
    setTuneText('');
    setToast('Anotado. Se aplica desde la próxima pregunta.');
    window.setTimeout(() => setToast(null), 2600);
  };

  if (state.phase === 'over') {
    return <ResultsScreen state={state} onExit={onExit} onRematch={onRematch} />;
  }

  // Durante el robo la tarjeta se pinta del color del ladron: la pregunta ya no
  // es del que estaba de turno.
  const stealing = state.phase === 'steal' || state.phase === 'stealJudging';
  const tint = tintFor((stealing ? thief?.skin : asker?.skin) ?? 0);
  const question = state.current;
  const last = state.history[state.history.length - 1];

  return (
    <div className="stack">
      <div className="spread">
        <Button tone="ghost" size="sm" onClick={() => setLeaving(true)}>
          ← Salir
        </Button>
        <span className="label muted">
          {state.questionNumber} / {game.rounds}
        </span>
        <Button tone="ghost" size="sm" onClick={() => setTuning(true)}>
          Ajustar ⚙
        </Button>
      </div>

      <Scoreboard
        players={state.players}
        scores={state.scores}
        activeId={stealing ? null : (asker?.id ?? null)}
        stealId={state.stealTo}
      />

      {game.timerSeconds !== null && state.phase === 'asking' ? (
        <TimerBar ratio={timer.ratio} left={timer.left} tint={tint} />
      ) : null}

      <div className="flex-space">
      {error ? (
        <div className="notice" style={{ ['--tint' as string]: 'var(--red)' }}>
          <div className="stack-sm grow">
            <span>{error}</span>
            <Button
              tone="plain"
              size="sm"
              onClick={() => {
                setError(null);
                setRetry((n) => n + 1);
              }}
            >
              Reintentar
            </Button>
          </div>
        </div>
      ) : null}

      {state.phase === 'waiting' && !error ? (
        <div className="card question-card center stack">
          <span className="label muted">Preparando el mazo</span>
          <Dots />
          {ready > 0 ? (
            <p className="answer-text">
              {ready} {ready === 1 ? 'pregunta lista' : 'preguntas listas'}
            </p>
          ) : null}
          <p className="muted">
            Se generan todas ahora, de una. Después la partida no vuelve a frenarse.
          </p>
        </div>
      ) : null}

      {question && state.phase !== 'waiting' ? (
        <article
          className={`card question-card anim-card${state.phase === 'steal' ? ' anim-pulse' : ''}`}
          key={question.id}
          style={{ ['--tint' as string]: tint }}
        >
          <div className="row question-meta">
            <span className="chip chip-on" style={{ ['--chip' as string]: tint }}>
              {stealing ? `Robo · ${thief?.name ?? ''}` : asker?.name}
            </span>
            <span className="chip">{question.topic}</span>
          </div>
          <h1 className="question-text">{question.prompt}</h1>
        </article>
      ) : null}

      {/* ---- El de turno responde ---- */}
      {state.phase === 'asking' && question ? (
        game.judgeMode === 'ia' ? (
          <div className="stack-sm">
            <div className="row">
              <input
                className="field grow"
                value={answer}
                placeholder="Escribí tu respuesta"
                autoComplete="off"
                autoCorrect="off"
                onChange={(event) => setAnswer(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && answer.trim()) {
                    dispatch({ type: 'answer', given: answer.trim() });
                  }
                }}
              />
              {speech.supported ? (
                <Button
                  tone={speech.listening ? 'pink' : 'cyan'}
                  aria-label="Dictar respuesta"
                  onClick={() => (speech.listening ? speech.stop() : speech.start())}
                >
                  {speech.listening ? '● Escuchando' : '🎙'}
                </Button>
              ) : null}
            </div>
            <Button
              tone="lime"
              size="lg"
              block
              disabled={!answer.trim()}
              onClick={() => {
                speech.stop();
                dispatch({ type: 'answer', given: answer.trim() });
              }}
            >
              Responder
            </Button>
            <Button tone="plain" block onClick={() => dispatch({ type: 'giveUp' })}>
              No sé, paso
            </Button>
          </div>
        ) : (
          <div className="stack-sm">
            <RevealBox answer={question.answer} open={showAnswer} onOpen={() => setShowAnswer(true)} />
            <div className="row row-stretch">
              {(
                [
                  ['incorrecta', 'Mal', 'red'],
                  ['parcial', 'Media', 'orange'],
                  ['correcta', 'Bien', 'green'],
                ] as [Verdict, string, 'red' | 'orange' | 'green'][]
              ).map(([verdict, label, tone]) => (
                <Button
                  key={verdict}
                  tone={tone}
                  size="lg"
                  block
                  className="grow"
                  onClick={() => dispatch({ type: 'verdict', verdict })}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        )
      ) : null}

      {state.phase === 'judging' && !judgeDown ? (
        <div className="card center stack-sm">
          <span className="label">Corrigiendo</span>
          <Dots />
          <p className="muted">Dijiste: «{state.given}»</p>
        </div>
      ) : null}

      {state.phase === 'judging' && judgeDown && question ? (
        <div className="stack-sm">
          <div className="notice" style={{ ['--tint' as string]: 'var(--orange)' }}>
            <span>El árbitro no contestó a tiempo. Decidan ustedes y sigan.</span>
          </div>
          <div className="card stack-sm">
            <span className="label muted">Dijo</span>
            <p className="answer-text">«{state.given}»</p>
            <span className="label muted">La respuesta era</span>
            <p className="answer-text">{question.answer}</p>
          </div>
          <div className="row row-stretch">
            {(
              [
                ['incorrecta', 'Mal', 'red'],
                ['parcial', 'Media', 'orange'],
                ['correcta', 'Bien', 'green'],
              ] as [Verdict, string, 'red' | 'orange' | 'green'][]
            ).map(([verdict, label, tone]) => (
              <Button
                key={verdict}
                tone={tone}
                size="lg"
                block
                className="grow"
                onClick={() => dispatch({ type: 'verdict', verdict })}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {/* ---- Ventana de robo ---- */}
      {state.phase === 'steal' && thief ? (
        <div className="stack-sm">
          <TimerBar ratio={stealClock.ratio} left={stealClock.left} tint="var(--pink)" />
          <p className="center steal-call">
            <b>{thief.name}</b>, ¿la sabías?
          </p>
          {game.judgeMode === 'ia' ? (
            <>
              <input
                className="field"
                value={answer}
                placeholder={`Respuesta de ${thief.name}`}
                autoComplete="off"
                onChange={(event) => setAnswer(event.target.value)}
              />
              <div className="row row-stretch">
                <Button
                  tone="pink"
                  size="lg"
                  block
                  className="grow"
                  disabled={!answer.trim()}
                  onClick={() => dispatch({ type: 'stealAnswer', given: answer.trim() })}
                >
                  Robar
                </Button>
                <Button tone="plain" size="lg" block className="grow" onClick={stealOver}>
                  Paso
                </Button>
              </div>
            </>
          ) : (
            <>
              <RevealBox answer={state.current?.answer ?? ''} open={showAnswer} onOpen={() => setShowAnswer(true)} />
              <div className="row row-stretch">
                <Button
                  tone="pink"
                  size="lg"
                  block
                  className="grow"
                  onClick={() => dispatch({ type: 'stealVerdict', verdict: 'correcta' })}
                >
                  Robó
                </Button>
                <Button tone="plain" size="lg" block className="grow" onClick={stealOver}>
                  Nadie robó
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {state.phase === 'stealJudging' && !judgeDown ? (
        <div className="card center stack-sm">
          <span className="label">Viendo si robó</span>
          <Dots />
        </div>
      ) : null}

      {state.phase === 'stealJudging' && judgeDown && question ? (
        <div className="stack-sm">
          <div className="notice" style={{ ['--tint' as string]: 'var(--orange)' }}>
            <span>El árbitro no contestó a tiempo. Decidan ustedes.</span>
          </div>
          <div className="card stack-sm">
            <span className="label muted">Dijo</span>
            <p className="answer-text">«{state.stealGiven}»</p>
            <span className="label muted">La respuesta era</span>
            <p className="answer-text">{question.answer}</p>
          </div>
          <div className="row row-stretch">
            <Button
              tone="pink"
              size="lg"
              block
              className="grow"
              onClick={() => dispatch({ type: 'stealVerdict', verdict: 'correcta' })}
            >
              Robó
            </Button>
            <Button
              tone="plain"
              size="lg"
              block
              className="grow"
              onClick={() => dispatch({ type: 'stealVerdict', verdict: 'incorrecta' })}
            >
              No robó
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---- Resultado de la ronda ---- */}
      {state.phase === 'reveal' && last ? (
        <div className="stack-sm anim-in">
          <div
            className={`verdict verdict-${last.stolenBy ? 'robo' : last.verdict}`}
          >
            <span className="verdict-word">
              {last.stolenBy
                ? `¡Robó ${state.players.find((p) => p.id === last.stolenBy)?.name}!`
                : last.verdict === 'correcta'
                  ? '¡Bien!'
                  : last.verdict === 'parcial'
                    ? 'A medias'
                    : 'Nop'}
            </span>
            <span className="verdict-points">
              {Object.entries(last.points)
                .filter(([, value]) => value > 0)
                .map(([id, value]) => {
                  const player = state.players.find((p) => p.id === id);
                  return `+${String(value).replace('.', ',')} ${player?.name ?? ''}`;
                })
                .join('  ·  ') || 'Sin puntos'}
            </span>
          </div>

          <div className="card stack-sm">
            <span className="label muted">La respuesta era</span>
            <p className="answer-text">{last.question.answer}</p>
            {last.question.note ? <p className="muted">{last.question.note}</p> : null}
            {state.reason && game.judgeMode === 'ia' ? (
              <p className="muted">Árbitro: {state.reason}</p>
            ) : null}
          </div>

          <Button tone="lime" size="lg" block onClick={() => dispatch({ type: 'next' })}>
            {state.questionNumber >= game.rounds ? 'Ver resultado' : 'Siguiente'}
          </Button>
        </div>
      ) : null}

      </div>

      {toast ? <div className="toast anim-in">{toast}</div> : null}

      <Sheet open={tuning} onClose={() => setTuning(false)} title="Ajustar las preguntas">
        <p className="muted">
          Decile qué cambiar, con tus palabras. Se aplica desde la próxima pregunta y las que ya
          estaban preparadas se descartan.
        </p>
        <div className="chips">
          {QUICK_FIXES.map((fix) => (
            <button key={fix} type="button" className="chip chip-tap" onClick={() => applyTuning(fix)}>
              {fix}
            </button>
          ))}
        </div>
        <textarea
          className="field"
          value={tuneText}
          maxLength={300}
          placeholder="Por ejemplo: menos preguntas de música y más de deportes."
          onChange={(event) => setTuneText(event.target.value)}
        />
        <Button tone="lime" block disabled={!tuneText.trim()} onClick={() => applyTuning(tuneText)}>
          Aplicar
        </Button>
        {deck.current?.corrections.length ? (
          <div className="card card-flat stack-sm">
            <span className="label muted">Ya le pediste</span>
            {deck.current.corrections.map((correction, index) => (
              <p key={index} className="muted">
                · {correction}
              </p>
            ))}
          </div>
        ) : null}
      </Sheet>

      <Sheet open={leaving} onClose={() => setLeaving(false)} title="¿Dejar la partida?">
        <p className="muted">Se pierde el marcador y las preguntas que quedaban preparadas.</p>
        <Button tone="red" block onClick={onExit}>
          Sí, salir
        </Button>
        <Button tone="ghost" block onClick={() => setLeaving(false)}>
          Seguir jugando
        </Button>
      </Sheet>
    </div>
  );
}

/** Tapa la respuesta hasta que el lector decida verla. */
function RevealBox({ answer, open, onOpen }: { answer: string; open: boolean; onOpen: () => void }) {
  if (!open) {
    return (
      <button type="button" className="reveal-box" onClick={() => { fx.tap(); onOpen(); }}>
        <span className="label">Tocá para ver la respuesta</span>
      </button>
    );
  }
  return (
    <div className="reveal-box is-open anim-in">
      <span className="label muted">Respuesta</span>
      <p className="answer-text">{answer}</p>
    </div>
  );
}
