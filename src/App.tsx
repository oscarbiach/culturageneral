import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GameSettings, Player } from './game/types';
import { HomeScreen } from './screens/Home';
import { SetupScreen } from './screens/Setup';
import { PlayScreen } from './screens/Play';
import { SettingsScreen } from './screens/Settings';
import { configureFeedback } from './ui/feedback';
import { loadSettings, saveSettings, type AppSettings } from './state/settings';

type Route =
  | { name: 'inicio' }
  | { name: 'armar' }
  | { name: 'jugar'; players: Player[]; game: GameSettings }
  | { name: 'ajustes' };

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [route, setRoute] = useState<Route>({ name: 'inicio' });

  useEffect(() => {
    saveSettings(settings);
    configureFeedback(settings.sound, settings.haptics);
    document.documentElement.dataset.theme = settings.theme;
  }, [settings]);

  // El color de la barra del sistema en modo app tiene que seguir al tema,
  // si no queda una franja blanca arriba de una pantalla oscura.
  useEffect(() => {
    const dark =
      settings.theme === 'oscuro' ||
      (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', dark ? '#0e0e14' : '#fff3dd');
  }, [settings.theme]);

  const patch = useCallback((changes: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...changes }));
  }, []);

  const goHome = useCallback(() => setRoute({ name: 'inicio' }), []);

  const screen = useMemo(() => {
    switch (route.name) {
      case 'armar':
        return (
          <SetupScreen
            settings={settings}
            onPatch={patch}
            onBack={goHome}
            onStart={(players, game) => {
              patch({ lastPlayers: players.map((p) => p.name), lastGame: game });
              setRoute({ name: 'jugar', players, game });
            }}
            onOpenSettings={() => setRoute({ name: 'ajustes' })}
          />
        );
      case 'jugar':
        return (
          <PlayScreen
            settings={settings}
            onPatch={patch}
            players={route.players}
            game={route.game}
            onExit={goHome}
            onRematch={() => setRoute({ name: 'jugar', players: route.players, game: route.game })}
          />
        );
      case 'ajustes':
        return <SettingsScreen settings={settings} onPatch={patch} onBack={goHome} />;
      default:
        return (
          <HomeScreen
            settings={settings}
            onPlay={() => setRoute({ name: 'armar' })}
            onOpenSettings={() => setRoute({ name: 'ajustes' })}
          />
        );
    }
  }, [route, settings, patch, goHome]);

  return (
    <div className="app" key={route.name}>
      {screen}
    </div>
  );
}
