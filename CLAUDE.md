# Mano a Mano — notas para trabajar en este repo

Juego de preguntas y respuestas 1vs1, mobile-first, publicado como sitio estático
en GitHub Pages. Las preguntas las genera una IA a pedido del usuario, no salen
de un banco precargado.

## Comandos

```bash
npm run dev                       # Vite en :5173
npm test                          # tests del motor (vitest)
npx tsc -b                        # tipos de la app
npx tsc --noEmit -p worker/tsconfig.json   # tipos del Worker
npm run build                     # produccion (APP_BASE define el base path)
npm run icons                     # regenera los PNG de la PWA
npm run fonts                     # rebaja las tipografias self-hosted
```

## Reglas de la casa

- **Todo el texto que ve el jugador va en castellano rioplatense.** Los nombres
  de variables y los tipos, en inglés, como el resto del código.
- **`src/shared/` lo importan la app y el Worker.** No metas ahí nada que dependa
  del DOM, de React, ni de las APIs de Node.
- **`src/game/engine.ts` es puro.** Nada de fetch, `Date.now()`, `Math.random()`
  ni React adentro. Si una funcionalidad necesita eso, va en la capa de arriba y
  entra al motor como una acción. Es lo que mantiene abierta la puerta al modo
  multi-dispositivo.
- **Cada cambio de reglas del juego se cubre con un test** en
  `src/game/engine.test.ts`. Son rápidos y no necesitan navegador.
- **Nunca loguees ni devuelvas una API key.** El Worker ya enmascara las que
  aparezcan en mensajes de error; si agregás un camino de error nuevo, revisá que
  siga haciéndolo.

## Diseño

Neobrutalismo arcade: trazo grueso (`--stroke`), sombra dura desplazada
(`--shadow`), colores planos saturados, tipografía Archivo Black para títulos y
Space Grotesk para el cuerpo.

- La paleta entera cuelga de `--ink` (trazo y texto) y `--paper` (fondo). El modo
  oscuro las invierte en `src/styles/tokens.css` y el resto sigue sin tocarse.
- `--tint` la setean las tarjetas para colorear su borde y **se hereda**. Un chip
  adentro de una tarjeta usa `--chip`, no `--tint`, justamente por eso.
- Cualquier animación nueva tiene que quedar quieta bajo
  `prefers-reduced-motion`; la regla global ya lo cubre si usás transiciones y
  `animation`.
- Los `input` no pueden bajar de 16px: iOS hace zoom al enfocarlos.

## Corregir no sale a la red

La IA sólo genera preguntas. El fallo lo dan los jugadores, apoyados en
`src/shared/quick-judge.ts`, que es puro y decide al instante cuando la respuesta
está escrita igual. **No vuelvas a meter una llamada de red en el camino de
corregir**: ya se probó y era el peor problema de la app —segundos de espera con
la mesa mirando, cupo gastado y timeouts—. Si `quick-judge` no está seguro,
devuelve null y decide la mesa; ese es el diseño, no una limitación.

## Protocolo con el Worker

`src/shared/contracts.ts` define el contrato y `PROTOCOL_VERSION`. Si cambiás la
forma de un request o de una respuesta, **subí la versión y redesplegá el Worker
junto con la app**; el Worker rechaza versiones que no coinciden con un mensaje
que le pide al jugador que recargue.

El Worker recibe tareas acotadas (`generate`, `judge`), nunca prompts libres:
así nadie que encuentre la URL puede usarlo como un chatbot gratis con la key del
dueño. Si agregás una tarea, validá y recortá sus parámetros en `contracts.ts`
(`clamp*`), que corre en los dos lados.
