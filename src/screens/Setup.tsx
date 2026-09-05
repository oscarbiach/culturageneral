import { useState } from 'react';
import { Button, Segmented, Switch } from '../ui/controls';
import { DIFFICULTIES, type Difficulty } from '../shared/contracts';
import { type GameSettings, type Player } from '../game/types';
import { isConfigured, type AppSettings } from '../state/settings';
import { tintFor } from '../ui/palette';
import { fx } from '../ui/feedback';

interface Props {
  settings: AppSettings;
  onPatch: (changes: Partial<AppSettings>) => void;
  onBack: () => void;
  onStart: (players: Player[], game: GameSettings) => void;
  onOpenSettings: () => void;
}

/** Atajos que se pegan al pedido. No son categorias cerradas: son texto. */
const IDEAS = [
  'Fútbol general',
  'Fútbol argentino',
  'Mundiales',
  'Cultura general',
  'Historia',
  'Música',
  'Cine y series',
  'Ciencia',
  'Geografía',
  'Comida',
  'Argentina',
  'Años 90',
];

const DIFFICULTY_LABEL: Record<Difficulty, string> = {
  facil: 'Fácil',
  normal: 'Normal',
  dificil: 'Difícil',
  brutal: 'Brutal',
};

const ROUND_OPTIONS = [10, 20, 30, 50];
const TIMER_OPTIONS = [15, 30, 45, 60];

export function SetupScreen({ settings, onPatch, onBack, onStart, onOpenSettings }: Props) {
  const [names, setNames] = useState<string[]>(() => {
    const saved = settings.lastPlayers;
    return [saved[0] || 'Jugador 1', saved[1] || 'Jugador 2'];
  });
  const [game, setGame] = useState<GameSettings>(() => ({ ...settings.lastGame }));

  const set = <K extends keyof GameSettings>(key: K, value: GameSettings[K]) =>
    setGame((current) => ({ ...current, [key]: value }));

  const addIdea = (idea: string) => {
    fx.tap();
    setGame((current) => {
      const brief = current.brief.trim();
      if (brief.toLowerCase().includes(idea.toLowerCase())) return current;
      return { ...current, brief: brief ? `${brief}, ${idea.toLowerCase()}` : idea };
    });
  };

  const ready = isConfigured(settings);

  const start = () => {
    const players: Player[] = names.map((name, index) => ({
      id: `p${index}`,
      name: name.trim() || `Jugador ${index + 1}`,
      skin: index,
    }));
    onStart(players, game);
  };

  return (
    <div className="stack">
      <div className="spread">
        <Button tone="ghost" size="sm" onClick={onBack} aria-label="Volver">
          ← Volver
        </Button>
        <span className="label muted">Armar partida</span>
      </div>

      <section className="stack-sm">
        <h2 className="section-title">Quiénes juegan</h2>
        <div className="row">
          {names.map((name, index) => (
            <input
              key={index}
              className="field grow player-field"
              style={{ ['--tint' as string]: tintFor(index) }}
              value={name}
              maxLength={14}
              aria-label={`Nombre del jugador ${index + 1}`}
              onChange={(event) => {
                const next = [...names];
                next[index] = event.target.value;
                setNames(next);
              }}
            />
          ))}
        </div>
        <p className="muted">
          Por ahora se juega uno contra uno, con un teléfono en la mesa.
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="section-title">Qué preguntas querés</h2>
        <textarea
          className="field"
          value={game.brief}
          maxLength={600}
          placeholder="Escribilo con tus palabras. Por ejemplo: fútbol argentino de los 90, nada de estadísticas raras. O: cultura general, pero sin tantas capitales ni geografía."
          onChange={(event) => set('brief', event.target.value)}
        />
        <div className="chips">
          {IDEAS.map((idea) => (
            <button key={idea} type="button" className="chip chip-tap" onClick={() => addIdea(idea)}>
              + {idea}
            </button>
          ))}
        </div>
        <p className="muted">
          Durante la partida podés seguir corrigiendo: «están muy difíciles», «menos geografía».
        </p>
      </section>

      <section className="stack-sm">
        <h2 className="section-title">Nivel</h2>
        <Segmented
          ariaLabel="Nivel de dificultad"
          value={game.difficulty}
          tint="var(--orange)"
          options={DIFFICULTIES.map((d) => ({ value: d, label: DIFFICULTY_LABEL[d] }))}
          onChange={(value) => set('difficulty', value)}
        />
      </section>

      <section className="stack-sm">
        <h2 className="section-title">Cuántas preguntas</h2>
        <Segmented
          ariaLabel="Cantidad de preguntas"
          value={String(game.rounds)}
          tint="var(--cyan)"
          options={ROUND_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          onChange={(value) => set('rounds', Number(value))}
        />
      </section>

      <section className="stack-sm">
        <h2 className="section-title">Quién corrige</h2>
        <Segmented
          ariaLabel="Modo de arbitraje"
          value={game.judgeMode}
          tint="var(--lime)"
          options={[
            { value: 'ia', label: 'Árbitro IA' },
            { value: 'manual', label: 'A mano' },
          ]}
          onChange={(value) => set('judgeMode', value)}
        />
        {game.judgeMode === 'ia' ? (
          <p className="muted">
            El de turno escribe o dicta su respuesta y la IA la corrige, aguantando errores de
            tipeo y sinónimos. Nadie ve la respuesta antes de tiempo, así que el robo es limpio.
          </p>
        ) : (
          <div className="notice" style={{ ['--tint' as string]: 'var(--cyan)' }}>
            <span>
              Necesitás a alguien que lea: la pantalla muestra la respuesta, así que el teléfono lo
              tiene que sostener quien no está jugando esa pregunta.
            </span>
          </div>
        )}
      </section>

      <section className="stack-sm">
        <h2 className="section-title">Reglas de la mesa</h2>
        <div className="card card-flat stack-sm">
          <Switch
            label="Robo"
            hint="Si el de turno falla, el rival puede llevarse medio punto."
            checked={game.stealSeconds > 0}
            onChange={(on) => set('stealSeconds', on ? 7 : 0)}
          />
          {game.stealSeconds > 0 ? (
            <Segmented
              ariaLabel="Segundos para robar"
              value={String(game.stealSeconds)}
              tint="var(--pink)"
              options={[5, 7, 10, 15].map((n) => ({ value: String(n), label: `${n}s` }))}
              onChange={(value) => set('stealSeconds', Number(value))}
            />
          ) : null}
        </div>

        <div className="card card-flat stack-sm">
          <Switch
            label="Cronómetro"
            hint="Tiempo límite para contestar cada pregunta."
            checked={game.timerSeconds !== null}
            onChange={(on) => set('timerSeconds', on ? 30 : null)}
          />
          {game.timerSeconds !== null ? (
            <Segmented
              ariaLabel="Segundos por pregunta"
              value={String(game.timerSeconds)}
              tint="var(--violet)"
              options={TIMER_OPTIONS.map((n) => ({ value: String(n), label: `${n}s` }))}
              onChange={(value) => set('timerSeconds', Number(value))}
            />
          ) : null}
        </div>
      </section>

      {!ready ? (
        <div className="notice" style={{ ['--tint' as string]: 'var(--orange)' }}>
          <span>
            Todavía no hay una IA conectada, así que no se pueden generar preguntas.{' '}
            <button className="linkish" onClick={onOpenSettings}>
              Configurar
            </button>
          </span>
        </div>
      ) : null}

      <Button
        tone="lime"
        size="lg"
        block
        disabled={!ready}
        onClick={() => {
          onPatch({ lastGame: game });
          start();
        }}
      >
        Empezar
      </Button>
    </div>
  );
}
