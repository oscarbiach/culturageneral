import { useEffect, useState } from 'react';
import { Button, Sheet } from '../ui/controls';
import { isConfigured, type AppSettings } from '../state/settings';

interface Props {
  settings: AppSettings;
  onPlay: () => void;
  onOpenSettings: () => void;
}

/**
 * Pedidos de ejemplo que rotan en la portada. Son la mejor forma de explicar de
 * que se trata la app: no hay categorias, hay una cosa que le pedis con palabras.
 */
const EJEMPLOS = [
  'fútbol argentino de los 90, nada de estadísticas raras',
  'cultura general, pero sin tantas capitales ni geografía',
  'mundiales, mezclá goles con anécdotas',
  'música y cine, difíciles de verdad',
  'preguntas cortas, que se entiendan a la primera',
];

/** True si la app ya se abre desde el icono de inicio y no desde el navegador. */
function isInstalled(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

export function HomeScreen({ settings, onPlay, onOpenSettings }: Props) {
  const [rules, setRules] = useState(false);
  const [install, setInstall] = useState(false);
  const [installed, setInstalled] = useState(true);
  const [ejemplo, setEjemplo] = useState(0);

  useEffect(() => {
    setInstalled(isInstalled());
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setEjemplo((n) => (n + 1) % EJEMPLOS.length), 3800);
    return () => window.clearInterval(id);
  }, []);

  const ready = isConfigured(settings);

  const share = async () => {
    const data = {
      title: 'Mano a Mano',
      text: 'Duelo de preguntas y respuestas. Las preguntas las pedis vos.',
      url: window.location.href,
    };
    try {
      if (navigator.share) await navigator.share(data);
      else await navigator.clipboard.writeText(data.url);
    } catch {
      // Cancelar el menu de compartir no es un error.
    }
  };

  return (
    <div className="stack" style={{ minHeight: '100%' }}>
      <div className="home-hero anim-in">
        <div className="home-title">
          <span>Mano</span>
          <span className="home-title-a">a</span>
          <span>Mano</span>
        </div>
        <p className="home-tag">
          Duelo de preguntas y respuestas.
          <br />
          Las preguntas las pedís vos.
        </p>
      </div>

      {!ready ? (
        <div className="notice" style={{ ['--tint' as string]: 'var(--orange)' }}>
          <span>
            Falta conectar la app con una IA para que pueda escribir las preguntas.{' '}
            <button className="linkish" onClick={onOpenSettings}>
              Configurar ahora
            </button>
          </span>
        </div>
      ) : null}

      <div className="grow" style={{ display: 'grid', placeItems: 'center' }}>
        <div className="prompt-demo">
          <span className="label muted">Vos le pedís</span>
          <p key={ejemplo} className="prompt-demo-text anim-in">
            «{EJEMPLOS[ejemplo]}»
          </p>
        </div>
      </div>

      <div className="stack">
        <Button tone="lime" size="lg" block onClick={onPlay}>
          Jugar
        </Button>
        <div className="row row-stretch">
          <Button tone="cyan" block className="grow" onClick={() => setRules(true)}>
            Reglas
          </Button>
          <Button tone="violet" block className="grow" onClick={onOpenSettings}>
            Ajustes
          </Button>
        </div>
        <div className="row">
          {!installed ? (
            <Button tone="ghost" size="sm" block className="grow" onClick={() => setInstall(true)}>
              Agregar a inicio
            </Button>
          ) : null}
          <Button tone="ghost" size="sm" block className="grow" onClick={share}>
            Compartir
          </Button>
        </div>
      </div>

      <Sheet open={rules} onClose={() => setRules(false)} title="Cómo se juega">
        <ol className="rules">
          <li>
            <b>Se juega de a dos, por turnos.</b> La pregunta 1 va para el primero, la 2 para el
            segundo, y así.
          </li>
          <li>
            <b>Acertar vale 1 punto.</b> Si la respuesta va por buen camino pero le falta el dato
            justo, es media respuesta y paga 0,5.
          </li>
          <li>
            <b>El robo.</b> Si el de turno falla o se rinde, el rival tiene unos segundos para
            robar medio punto. No es para pensarla: es solo si ya la sabías.
          </li>
          <li>
            <b>El fallo lo dan ustedes.</b> Si escribís la respuesta igual, el punto es automático.
            Si no, la app la revela y la mesa decide: bien, media o mal.
          </li>
          <li>
            <b>Las preguntas se piden.</b> Antes de arrancar escribís qué querés, con tus palabras.
            Y en cualquier momento de la partida podés corregir: «están muy difíciles», «menos
            geografía», «más fútbol argentino».
          </li>
        </ol>
        <Button tone="lime" block onClick={() => setRules(false)}>
          Listo
        </Button>
      </Sheet>

      <Sheet open={install} onClose={() => setInstall(false)} title="Agregar a inicio">
        <p className="muted">
          Se instala como una app de verdad: icono propio, pantalla completa y sin barra del
          navegador.
        </p>
        <div className="card card-flat stack-sm">
          <span className="label">iPhone · Safari</span>
          <p className="muted">
            Tocá el botón de compartir (el cuadrado con la flecha) y elegí «Agregar a pantalla de
            inicio».
          </p>
        </div>
        <div className="card card-flat stack-sm">
          <span className="label">Android · Chrome</span>
          <p className="muted">
            Abrí el menú de los tres puntos y elegí «Instalar aplicación» o «Agregar a pantalla
            principal».
          </p>
        </div>
        <Button tone="lime" block onClick={() => setInstall(false)}>
          Entendido
        </Button>
      </Sheet>
    </div>
  );
}
