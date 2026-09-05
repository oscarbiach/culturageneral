import { useEffect, useMemo, useState } from 'react';
import { isTie, standings } from '../game/engine';
import type { GameState } from '../game/types';
import { Button, Sheet } from '../ui/controls';
import { Confetti, formatScore } from '../ui/game-bits';
import { fx } from '../ui/feedback';
import { tintFor } from '../ui/palette';

interface Props {
  state: GameState;
  onExit: () => void;
  onRematch: () => void;
}

export function ResultsScreen({ state, onExit, onRematch }: Props) {
  const table = useMemo(() => standings(state), [state]);
  const tie = isTie(state);
  const [review, setReview] = useState(false);

  useEffect(() => {
    fx.win();
  }, []);

  const stats = useMemo(() => {
    const byPlayer = new Map(state.players.map((p) => [p.id, { hits: 0, steals: 0 }]));
    for (const round of state.history) {
      if (round.verdict === 'correcta' || round.verdict === 'parcial') {
        const entry = byPlayer.get(round.askedTo);
        if (entry) entry.hits += 1;
      }
      if (round.stolenBy) {
        const entry = byPlayer.get(round.stolenBy);
        if (entry) entry.steals += 1;
      }
    }
    return byPlayer;
  }, [state]);

  const share = async () => {
    const lines = table.map((row) => `${row.player.name}: ${formatScore(row.score)}`);
    const text = `Mano a Mano — ${state.history.length} preguntas\n${lines.join('\n')}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Mano a Mano', text });
      else await navigator.clipboard.writeText(text);
    } catch {
      // cancelar no es error
    }
  };

  return (
    <div className="stack">
      {!tie ? <Confetti /> : null}

      <div className="center stack-sm" style={{ paddingTop: 12 }}>
        <span className="label muted">Final</span>
        <h1 className="winner-title">
          {tie ? 'Empate' : `Ganó ${table[0].player.name}`}
        </h1>
      </div>

      <div className="flex-space">
        {table.map((row, index) => (
          <div
            key={row.player.id}
            className={`result-row${index === 0 && !tie ? ' is-winner' : ''}`}
            style={{
              ['--tint' as string]: tintFor(row.player.skin),
              animationDelay: `${index * 90}ms`,
            }}
          >
            <span className="result-pos">{row.position}</span>
            <div className="grow">
              <div className="result-name truncate">{row.player.name}</div>
              <div className="muted">
                {stats.get(row.player.id)?.hits ?? 0} acertadas ·{' '}
                {stats.get(row.player.id)?.steals ?? 0} robos
              </div>
            </div>
            <span className="result-score">{formatScore(row.score)}</span>
          </div>
        ))}
      </div>

      <div className="stack-sm">
        <Button tone="lime" size="lg" block onClick={onRematch}>
          Revancha
        </Button>
        <div className="row row-stretch">
          <Button tone="cyan" block className="grow" onClick={() => setReview(true)}>
            Ver preguntas
          </Button>
          <Button tone="violet" block className="grow" onClick={share}>
            Compartir
          </Button>
        </div>
        <Button tone="ghost" block onClick={onExit}>
          Volver al inicio
        </Button>
      </div>

      <Sheet open={review} onClose={() => setReview(false)} title="Las preguntas de la partida">
        <div className="stack-sm">
          {state.history.map((round, index) => {
            const asked = state.players.find((p) => p.id === round.askedTo);
            const thief = state.players.find((p) => p.id === round.stolenBy);
            return (
              <div key={round.question.id} className="card card-flat stack-sm">
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <span className="chip">#{index + 1}</span>
                  <span className="chip chip-on" style={{ ['--chip' as string]: tintFor(asked?.skin ?? 0) }}>
                    {asked?.name}
                  </span>
                  <span
                    className="chip chip-on"
                    style={{
                      ['--chip' as string]:
                        round.verdict === 'correcta'
                          ? 'var(--green)'
                          : round.verdict === 'parcial'
                            ? 'var(--orange)'
                            : 'var(--red)',
                    }}
                  >
                    {round.verdict}
                  </span>
                  {thief ? (
                    <span className="chip chip-on" style={{ ['--chip' as string]: 'var(--pink)' }}>
                      robó {thief.name}
                    </span>
                  ) : null}
                </div>
                <p>{round.question.prompt}</p>
                <p className="muted">
                  <b>{round.question.answer}</b>
                  {round.given ? ` — dijo: «${round.given}»` : ''}
                </p>
              </div>
            );
          })}
        </div>
        <Button tone="lime" block onClick={() => setReview(false)}>
          Cerrar
        </Button>
      </Sheet>
    </div>
  );
}
