# Mano a Mano

Duelo de preguntas y respuestas para jugar entre amigos, con un teléfono apoyado
en la mesa. Las preguntas no salen de una biblioteca: se las pedís a una IA con
tus palabras, y podés seguir corrigiéndola en plena partida.

> «Fútbol argentino de los 90, nada de estadísticas raras.»
> «Cultura general, pero sin tantas capitales ni geografía.»
> «Están muy difíciles, bajá el nivel.»

Es una web app: se abre desde el link, se agrega a la pantalla de inicio y a
partir de ahí se comporta como una app cualquiera — icono propio, pantalla
completa, y abre aunque la señal esté mala.

## Cómo se juega

- Se juega uno contra uno, por turnos. La pregunta 1 va para el primero, la 2
  para el segundo, y así.
- Acertar vale **1 punto**. Si la respuesta va por buen camino pero le falta el
  dato justo, es media respuesta y paga **0,5**.
- **El robo:** si el de turno falla o se rinde, el rival tiene unos segundos para
  llevarse **0,5**. No es para pensarla, es solo si ya la sabías.
- El cronómetro por pregunta viene apagado y se prende en los ajustes de la
  partida.

### Quién corrige

| Modo | Cómo funciona | Cuándo conviene |
| --- | --- | --- |
| **Árbitro IA** (por defecto) | El de turno escribe o dicta su respuesta y la IA la corrige, aguantando errores de tipeo, apodos y sinónimos. | Cuando son solo dos y un teléfono. Nadie ve la respuesta antes de tiempo, así que el robo es limpio. |
| **A mano** | La pantalla muestra pregunta y respuesta, y alguien toca Mal / Media / Bien. | Cuando hay un tercero que lee, como se jugaba antes de que existiera la app. |

## Ponerla a andar

Son dos piezas: la app (estática, en GitHub Pages) y un proxy (un Cloudflare
Worker) que guarda la API key. GitHub Pages no puede guardar un secreto, por eso
la key vive del otro lado.

```
teléfono  ──►  GitHub Pages (la app)  ──►  Cloudflare Worker (tu API key)  ──►  Gemini / Claude / OpenAI / …
```

### 1. El Worker

```bash
cd worker
npm install
npx wrangler login

# La key del proveedor que quieras usar
npx wrangler secret put GEMINI_API_KEY

# Recomendado: un código que tenga que saber quien juegue, para que nadie que
# encuentre la URL te gaste la key
npx wrangler secret put ACCESS_CODE

npm run deploy
```

Te devuelve una URL tipo `https://mano-a-mano.tu-usuario.workers.dev`. Probala
entrando a `.../health`: te dice qué proveedor tiene configurado y si encontró la
key.

Antes de publicar, editá `worker/wrangler.toml`:

- `PROVIDER` y `MODEL`: cuál usar y con qué modelo.
- `ALLOWED_ORIGINS`: cambialo de `*` a `https://tu-usuario.github.io` para que tu
  key no se pueda usar desde otra página.
- `RATE_LIMIT` + el bloque `kv_namespaces`: descomentalos y creá el KV con
  `npx wrangler kv namespace create RATE` si querés un tope de pedidos por hora.

### 2. La app

En el repo, **Settings → Pages → Source: GitHub Actions**. Después, en
**Settings → Secrets and variables → Actions → Variables**, creá la variable
`PROXY_URL` con la URL del Worker.

Cada push a la rama publica el sitio en
`https://tu-usuario.github.io/culturageneral/`. Como la URL del Worker queda
horneada en el build, los jugadores abren el link y juegan: no tienen que
configurar nada.

### Sin Worker, para probar hoy mismo

En **Ajustes → De dónde salen las preguntas** elegís «Mi propia key», pegás una
API key y listo. Es un modo avanzado: la key queda guardada en ese teléfono, en
el almacenamiento del navegador, y se usa para hablar directo con el proveedor.
Sirve para probar antes de desplegar nada, pero no es lo que querés para pasarle
el link a tus amigos.

## Proveedores

Se puede elegir en Ajustes; el que manda es el que tiene la key.

| Proveedor | Cómo viene |
| --- | --- |
| Google Gemini | Capa gratuita real. El más fácil para arrancar. |
| Anthropic (Claude) | El que mejor obedece pedidos con matices tipo «menos capitales». |
| OpenAI | Requiere créditos cargados. |
| Groq | Muy rápido y con capa gratuita; las preguntas salen más planas. |
| OpenRouter | Una sola key para decenas de modelos, algunos gratis. |

Los modelos por defecto pueden quedar viejos: el campo es de texto libre y, en
modo «mi propia key», el botón **Cargar** trae la lista real que tu key tiene
habilitada.

## Desarrollo

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # tests del motor de juego
npx tsc -b         # tipos

npm run icons      # regenera los iconos de la PWA
npm run fonts      # rebaja las tipografias a src/styles/fonts/

cd worker && npm run dev   # el proxy en http://localhost:8787
```

Para probar la app contra el Worker local, en Ajustes poné
`http://localhost:8787` como dirección del servidor.

## Cómo está armado

```
src/
  shared/      contratos, prompts y llamadas a proveedores — lo comparten la app y el Worker
  game/        el motor: un reducer puro, sin React ni red (engine.ts + sus tests)
  ai/          transporte (proxy o key propia) y el mazo con precarga
  screens/     inicio, armar partida, jugar, resultado, ajustes
  ui/          controles, marcador, cronómetro, sonido y vibración
  styles/      tokens de diseño, base y componentes
worker/        el Cloudflare Worker que guarda la key
```

Dos decisiones que explican el resto:

- **El motor es una función pura.** `reduce(state, action)` no sabe de React, ni
  de red, ni del reloj. Todo lo que pasa en una partida entra por una acción, así
  que el día que se quiera jugar desde varios teléfonos alcanza con transportar
  acciones por la red y correr el mismo reducer en cada dispositivo. Por eso hoy
  el juego es 1vs1 pero el motor ya trabaja con una lista de jugadores y calcula
  a quién le toca robar: ampliar a 4 o 6, o abrir el robo a toda la mesa, es
  cambiar la pantalla de armado, no el motor.
- **Los prompts viven en `src/shared/`.** Los importan tanto el navegador como el
  Worker, así las preguntas salen iguales por los dos caminos.
