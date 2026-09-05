import { useEffect, useMemo, useRef, useState } from 'react';
import type { Player, PlayerId } from '../game/types';
import { tintFor } from './palette';
import { fx } from './feedback';

/** Medio punto se muestra como 0,5 y el entero sin coma. Detalle, pero se nota. */
export function formatScore(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace('.', ',');
}

interface ScoreboardProps {
  players: Player[];
  scores: Record<PlayerId, number>;
  activeId: PlayerId | null;
  /** A quien esta habilitado el robo, para marcarlo distinto. */
  stealId?: PlayerId | null;
}

export function Scoreboard({ players, scores, activeId, stealId }: ScoreboardProps) {
  return (
    <div className="scoreboard">
      {players.map((player) => (
        <ScoreTile
          key={player.id}
          player={player}
          score={scores[player.id] ?? 0}
          active={player.id === activeId}
          stealing={player.id === stealId}
        />
      ))}
    </div>
  );
}

function ScoreTile({
  player,
  score,
  active,
  stealing,
}: {
  player: Player;
  score: number;
  active: boolean;
  stealing: boolean;
}) {
  const [bumped, setBumped] = useState(false);
  const previous = useRef(score);

  useEffect(() => {
    if (score === previous.current) return;
    previous.current = score;
    setBumped(true);
    const id = window.setTimeout(() => setBumped(false), 500);
    return () => window.clearTimeout(id);
  }, [score]);

  return (
    <div
      className={`score-tile${active ? ' is-active' : ''}${stealing ? ' is-stealing' : ''}`}
      style={{ ['--tint' as string]: tintFor(player.skin) }}
    >
      <span className="score-name truncate">{player.name}</span>
      <span className={`score-value${bumped ? ' anim-pop' : ''}`}>{formatScore(score)}</span>
    </div>
  );
}

/**
 * Cuenta regresiva. Devuelve los segundos restantes y la fraccion consumida,
 * y avisa una sola vez cuando llega a cero.
 */
export function useCountdown(seconds: number | null, running: boolean, onEnd: () => void) {
  const [left, setLeft] = useState(seconds ?? 0);
  const ended = useRef(false);
  const endRef = useRef(onEnd);
  endRef.current = onEnd;

  useEffect(() => {
    setLeft(seconds ?? 0);
    ended.current = false;
  }, [seconds, running]);

  useEffect(() => {
    if (!running || seconds == null) return undefined;
    const deadline = Date.now() + seconds * 1000;
    const id = window.setInterval(() => {
      const remaining = Math.max(0, (deadline - Date.now()) / 1000);
      setLeft(remaining);
      if (remaining <= 3 && remaining > 0) fx.tick();
      if (remaining <= 0 && !ended.current) {
        ended.current = true;
        window.clearInterval(id);
        endRef.current();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [running, seconds]);

  const ratio = seconds ? Math.max(0, Math.min(1, left / seconds)) : 0;
  return { left, ratio };
}

interface TimerBarProps {
  ratio: number;
  left: number;
  tint?: string;
}

export function TimerBar({ ratio, left, tint = 'var(--violet)' }: TimerBarProps) {
  // Bajo el 30% se pone rojo: se ve de reojo, sin tener que leer el numero.
  const urgent = ratio <= 0.3;
  return (
    <div className="timer">
      <div
        className="timer-fill"
        style={{
          transform: `scaleX(${ratio})`,
          background: urgent ? 'var(--red)' : tint,
        }}
      />
      <span className="timer-label">{Math.ceil(left)}s</span>
    </div>
  );
}

/** Puntos que rebotan mientras se esperan preguntas. */
export function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ animationDelay: `${i * 0.16}s` }} />
      ))}
    </span>
  );
}

/**
 * Papelitos para el final. Son divs con una animacion CSS y se limpian solos:
 * no vale la pena un canvas para diez segundos de fiesta.
 */
export function Confetti({ pieces = 44 }: { pieces?: number }) {
  const bits = useMemo(
    () =>
      Array.from({ length: pieces }, (_, i) => ({
        id: i,
        left: Math.random() * 100,
        delay: Math.random() * 0.7,
        duration: 1.9 + Math.random() * 1.6,
        dx: `${(Math.random() - 0.5) * 180}px`,
        spin: `${540 + Math.random() * 720}deg`,
        tint: tintFor(Math.floor(Math.random() * 6)),
        size: 8 + Math.random() * 8,
      })),
    [pieces],
  );

  return (
    <div className="confetti" aria-hidden="true">
      {bits.map((bit) => (
        <i
          key={bit.id}
          style={{
            left: `${bit.left}%`,
            width: bit.size,
            height: bit.size * 1.6,
            background: bit.tint,
            animationDelay: `${bit.delay}s`,
            animationDuration: `${bit.duration}s`,
            ['--dx' as string]: bit.dx,
            ['--spin' as string]: bit.spin,
          }}
        />
      ))}
    </div>
  );
}
