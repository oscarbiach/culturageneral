import { useState } from 'react';
import { PROVIDERS, listModels, providerMeta } from '../shared/providers';
import type { ProviderId } from '../shared/contracts';
import { createAiClient } from '../ai/transport';
import { configProblem, type AppSettings, type ConnectionMode, type Theme } from '../state/settings';
import { Button, Segmented, Switch } from '../ui/controls';
import { Dots } from '../ui/game-bits';

interface Props {
  settings: AppSettings;
  onPatch: (changes: Partial<AppSettings>) => void;
  onBack: () => void;
}

type Check = { state: 'idle' | 'running' } | { state: 'ok' | 'fail'; message: string };

export function SettingsScreen({ settings, onPatch, onBack }: Props) {
  const [models, setModels] = useState<string[] | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [showKey, setShowKey] = useState(false);

  const meta = providerMeta(settings.provider);
  const direct = settings.connection === 'directa';
  const problem = configProblem(settings);

  const pickProvider = (provider: ProviderId) => {
    setModels(null);
    onPatch({ provider, model: providerMeta(provider).defaultModel });
  };

  const loadModels = async () => {
    setLoadingModels(true);
    try {
      const list = await listModels({ provider: settings.provider, apiKey: settings.apiKey });
      setModels(list);
    } catch (error) {
      setCheck({ state: 'fail', message: (error as Error).message });
    } finally {
      setLoadingModels(false);
    }
  };

  /** La unica prueba que vale: pedir una pregunta de verdad. */
  const test = async () => {
    setCheck({ state: 'running' });
    try {
      const result = await createAiClient(
        () => settings,
        (model) => onPatch({ model }),
      ).generate({
        brief: 'Una pregunta cualquiera de cultura general, bien facil.',
        count: 1,
        difficulty: 'facil',
        avoid: [],
        feedback: [],
      });
      const question = result.questions[0];
      setCheck({
        state: 'ok',
        message: `Anda. Ejemplo: «${question.prompt}» → ${question.answer}`,
      });
    } catch (error) {
      setCheck({ state: 'fail', message: (error as Error).message });
    }
  };

  return (
    <div className="stack">
      <div className="spread">
        <Button tone="ghost" size="sm" onClick={onBack}>
          ← Volver
        </Button>
        <span className="label muted">Ajustes</span>
      </div>

      <section className="stack-sm">
        <h2 className="section-title">De dónde salen las preguntas</h2>
        <Segmented<ConnectionMode>
          ariaLabel="Modo de conexión"
          value={settings.connection}
          tint="var(--cyan)"
          options={[
            { value: 'proxy', label: 'Servidor del grupo' },
            { value: 'directa', label: 'Mi propia key' },
          ]}
          onChange={(connection) => {
            setCheck({ state: 'idle' });
            onPatch({ connection });
          }}
        />
        <p className="muted">
          {direct
            ? 'Este teléfono habla directo con la IA usando tu API key, que queda guardada solamente acá y nunca viaja a ningún otro lado. Es lo que necesitás para jugar hoy.'
            : 'La app le pide las preguntas a un servidor propio que guarda la key, así los jugadores no configuran nada. Hay que montarlo antes (está explicado en el README).'}
        </p>
        {problem ? (
          <div className="notice" style={{ ['--tint' as string]: 'var(--orange)' }}>
            <span>{problem}</span>
          </div>
        ) : null}
      </section>

      {!direct ? (
        <section className="stack-sm">
          <label className="label" htmlFor="proxy-url">
            Dirección del servidor
          </label>
          <input
            id="proxy-url"
            className="field"
            value={settings.proxyUrl}
            placeholder="https://mano-a-mano.tu-usuario.workers.dev"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => onPatch({ proxyUrl: event.target.value.trim() })}
          />
          <label className="label" htmlFor="proxy-code">
            Código de acceso (si el servidor pide uno)
          </label>
          <input
            id="proxy-code"
            className="field"
            value={settings.accessCode}
            placeholder="Opcional"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => onPatch({ accessCode: event.target.value.trim() })}
          />
        </section>
      ) : null}

      <section className="stack-sm">
        <h2 className="section-title">Proveedor de IA</h2>
        <div className="chips">
          {PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              className={`chip chip-tap${settings.provider === provider.id ? ' chip-on' : ''}`}
              style={
                settings.provider === provider.id
                  ? { ['--chip' as string]: 'var(--violet)' }
                  : undefined
              }
              onClick={() => pickProvider(provider.id)}
            >
              {provider.label}
            </button>
          ))}
        </div>
        <p className="muted">{meta.hint}</p>

        <label className="label" htmlFor="model">
          Modelo
        </label>
        <div className="row">
          <input
            id="model"
            className="field grow"
            value={settings.model}
            list="model-options"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => onPatch({ model: event.target.value.trim() })}
          />
          {direct ? (
            <Button size="sm" tone="cyan" disabled={!settings.apiKey || loadingModels} onClick={loadModels}>
              {loadingModels ? '...' : 'Cargar'}
            </Button>
          ) : null}
        </div>
        <datalist id="model-options">
          {(models ?? []).map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        {models ? <p className="muted">{models.length} modelos disponibles con esa key.</p> : null}

        {direct ? (
          <>
            <label className="label" htmlFor="api-key">
              API key
            </label>
            <div className="row">
              <input
                id="api-key"
                className="field grow"
                type={showKey ? 'text' : 'password'}
                value={settings.apiKey}
                placeholder="Pegá tu key"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => onPatch({ apiKey: event.target.value.trim() })}
              />
              <Button size="sm" tone="ghost" onClick={() => setShowKey((v) => !v)}>
                {showKey ? 'Ocultar' : 'Ver'}
              </Button>
            </div>
            <p className="muted">
              Se saca en <span className="mono">{meta.keysUrl}</span>. Queda guardada en este
              teléfono, en el almacenamiento del navegador.
            </p>
          </>
        ) : null}
      </section>

      <section className="stack-sm">
        <Button
          tone="lime"
          block
          disabled={check.state === 'running' || problem !== null}
          onClick={test}
        >
          {check.state === 'running' ? 'Probando' : 'Probar conexión'}
        </Button>
        {check.state === 'running' ? (
          <div className="center">
            <Dots />
          </div>
        ) : null}
        {check.state === 'ok' ? (
          <div className="notice" style={{ ['--tint' as string]: 'var(--green)' }}>
            <span>{check.message}</span>
          </div>
        ) : null}
        {check.state === 'fail' ? (
          <div className="notice" style={{ ['--tint' as string]: 'var(--red)' }}>
            <span>{check.message}</span>
          </div>
        ) : null}
      </section>

      <section className="stack-sm">
        <h2 className="section-title">La app</h2>
        <Segmented<Theme>
          ariaLabel="Tema"
          value={settings.theme}
          tint="var(--orange)"
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'claro', label: 'Claro' },
            { value: 'oscuro', label: 'Oscuro' },
          ]}
          onChange={(theme) => onPatch({ theme })}
        />
        <div className="card card-flat">
          <Switch
            label="Sonido"
            hint="Bleeps de acierto, error y robo."
            checked={settings.sound}
            onChange={(sound) => onPatch({ sound })}
          />
          <Switch
            label="Vibración"
            hint="Solo en teléfonos que la soportan."
            checked={settings.haptics}
            onChange={(haptics) => onPatch({ haptics })}
          />
        </div>
      </section>
    </div>
  );
}
