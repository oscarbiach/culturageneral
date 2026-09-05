/**
 * Sonido y vibracion.
 *
 * Los bleeps se sintetizan con WebAudio en vez de cargar archivos: pesan cero,
 * no hay que esperarlos y suenan a arcade. El contexto se crea recien con el
 * primer toque porque los navegadores moviles no dejan sonar antes.
 */

let ctx: AudioContext | null = null;
let soundOn = true;
let hapticsOn = true;

export function configureFeedback(sound: boolean, haptics: boolean): void {
  soundOn = sound;
  hapticsOn = haptics;
}

function audio(): AudioContext | null {
  if (!soundOn) return null;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, duration: number, type: OscillatorType, at = 0, gain = 0.09): void {
  const ac = audio();
  if (!ac) return;
  const start = ac.currentTime + at;
  const osc = ac.createOscillator();
  const vol = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  // Ataque instantaneo y caida exponencial: el "tick" de un arcade.
  vol.gain.setValueAtTime(gain, start);
  vol.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(vol).connect(ac.destination);
  osc.start(start);
  osc.stop(start + duration);
}

function buzz(pattern: number | number[]): void {
  if (!hapticsOn) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Safari en iOS no lo soporta; no pasa nada.
  }
}

export const fx = {
  tap(): void {
    tone(520, 0.05, 'square', 0, 0.05);
    buzz(8);
  },
  correct(): void {
    tone(660, 0.09, 'square');
    tone(880, 0.09, 'square', 0.08);
    tone(1320, 0.16, 'square', 0.16);
    buzz([12, 40, 24]);
  },
  wrong(): void {
    tone(200, 0.14, 'sawtooth', 0, 0.07);
    tone(140, 0.22, 'sawtooth', 0.1, 0.07);
    buzz([26, 60, 26]);
  },
  partial(): void {
    tone(600, 0.1, 'triangle');
    tone(760, 0.14, 'triangle', 0.09);
    buzz(20);
  },
  steal(): void {
    tone(940, 0.06, 'square', 0, 0.07);
    tone(1200, 0.1, 'square', 0.06, 0.07);
    buzz([10, 30, 10, 30, 10]);
  },
  tick(): void {
    tone(1100, 0.03, 'square', 0, 0.035);
  },
  win(): void {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.2, 'square', i * 0.11));
    buzz([30, 60, 30, 60, 90]);
  },
};
