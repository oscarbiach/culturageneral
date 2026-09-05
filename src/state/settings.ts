/**
 * Preferencias del dispositivo. Todo vive en localStorage: la app no tiene
 * cuentas ni servidor propio, asi que lo que configuras queda en tu telefono.
 */

import type { ProviderId } from '../shared/contracts';
import { providerMeta } from '../shared/providers';
import { DEFAULT_SETTINGS, type GameSettings } from '../game/types';

export type ConnectionMode = 'proxy' | 'directa';
export type Theme = 'auto' | 'claro' | 'oscuro';

export interface AppSettings {
  /**
   * 'proxy' usa el Cloudflare Worker del duenio de la app: los jugadores no
   * configuran nada. 'directa' es el modo avanzado, con la key de uno mismo
   * guardada en este telefono.
   */
  connection: ConnectionMode;
  proxyUrl: string;
  /** Codigo que el Worker exige, si su duenio configuro uno. */
  accessCode: string;
  provider: ProviderId;
  model: string;
  apiKey: string;
  theme: Theme;
  sound: boolean;
  haptics: boolean;
  /** Nombres y ajustes de la ultima partida, para no recargarlos cada vez. */
  lastPlayers: string[];
  lastGame: GameSettings;
}

const KEY = 'manoamano.settings.v1';

/**
 * La URL del proxy se hornea en el build (variable de entorno del workflow de
 * GitHub Actions), asi los jugadores abren el link y juegan sin tocar Ajustes.
 */
const BAKED_PROXY = (import.meta.env?.VITE_PROXY_URL as string | undefined) ?? '';

export function defaultSettings(): AppSettings {
  return {
    connection: BAKED_PROXY ? 'proxy' : 'directa',
    proxyUrl: BAKED_PROXY,
    accessCode: '',
    provider: 'gemini',
    model: providerMeta('gemini').defaultModel,
    apiKey: '',
    theme: 'auto',
    sound: true,
    haptics: true,
    lastPlayers: ['Jugador 1', 'Jugador 2'],
    lastGame: { ...DEFAULT_SETTINGS },
  };
}

export function loadSettings(): AppSettings {
  const base = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...base,
      ...saved,
      // Si el duenio redesplegó apuntando a otro Worker, esa URL gana sobre la
      // vieja que quedo guardada en el telefono.
      proxyUrl: BAKED_PROXY || saved.proxyUrl || '',
      lastGame: { ...base.lastGame, ...(saved.lastGame ?? {}) },
    };
  } catch {
    return base;
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Modo incognito o almacenamiento lleno: se juega igual, sin recordar nada.
  }
}

/** True si la app puede pedirle preguntas a alguien. */
export function isConfigured(s: AppSettings): boolean {
  return s.connection === 'proxy' ? Boolean(s.proxyUrl) : Boolean(s.apiKey && s.model);
}
