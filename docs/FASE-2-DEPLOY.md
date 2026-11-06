# Fase 2 · Deploy estático en Vercel

**Estado:** configuración escrita y verificada en local, sin deploy real.
**Base:** rama `fase-2-red`, commit `4b81c53a5`.
**Alcance:** publicar el cliente como sitio estático en Vercel. La simulación sigue
corriendo en el browser y la red es Supabase Realtime; no hay servidor Node en
producción.

---

## 1. Variables de entorno

Se cargan en **Project Settings → Environment Variables**. Todas son de build: el
sitio resultante es estático y no lee variables en runtime.

### Obligatorias

| Variable                        | Para qué                                                          |
| ------------------------------- | ----------------------------------------------------------------- |
| `GAME_ENV`                      | `dev`, `staging` o `prod`. `packages/shared` la parsea al cargar. |
| `TURNSTILE_SITE_KEY`            | Clave pública de Cloudflare Turnstile que viaja en el HTML.       |
| `DOMAIN`                        | Dominio del proyecto. Se usa para derivar `jwtAudience`.          |
| `GIT_COMMIT`                    | Versión que muestra el cliente. Si falta, el build usa `dev`.     |
| `VITE_SUPABASE_URL`             | URL del proyecto Supabase. Se hornea en el bundle.                |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Clave **publishable** de Supabase. Se hornea en el bundle.        |

`GIT_COMMIT` no hace falta cargarla a mano: el `buildCommand` usa
`${VERCEL_GIT_COMMIT_SHA:-dev}`. Si querés fijarla, definila igual y ganará la del
entorno.

### Opcionales

| Variable                 | Efecto cuando falta                           |
| ------------------------ | --------------------------------------------- |
| `CDN_BASE`               | Los assets se sirven desde el mismo dominio.  |
| `STRIPE_PUBLISHABLE_KEY` | Se omite la línea de Stripe en el HTML.       |
| `FARO_COLLECTOR_URL`     | Se omite la línea de telemetría Grafana Faro. |

### Prohibidas

Nunca cargar `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SECRET_KEY` ni ninguna clave
privada. Todo lo que empieza con `VITE_` termina dentro del bundle y es público.
La clave publishable está diseñada para eso; la service role no.

---

## 2. `vercel.json`

### Build

```sh
npm run build-prod
GIT_COMMIT="${VERCEL_GIT_COMMIT_SHA:-dev}" \
  tsx src/server/RenderStaticIndex.ts --environment-only > static/index.render.html
mv static/index.render.html static/index.html
```

`npm run build-prod` corre `tsc --noEmit`, `vite build` y `scripts/buildAssetHashes.ts`;
deja `static/` con el shell sin resolver los 16 placeholders EJS.
`RenderStaticIndex.ts --environment-only` toma `static/index.html`, inyecta env y
manifest, y lo escribe en stdout.

**Por qué escribe a un archivo temporal y después lo mueve:** el input del
renderer _es_ `static/index.html`. Un `> static/index.html` directo trunca el
archivo antes de que Node lo lea, el renderer recibe una cadena vacía y falla.
Verificado en local: el redirect directo deja el archivo en 0 bytes y sale con
código 1.

`build-prod` ya corre `tsc --noEmit`, así que un error de tipos rompe el deploy.

### Rutas

| Regla                    | Tipo         | Efecto                                                |
| ------------------------ | ------------ | ----------------------------------------------------- |
| `/` sin `?lobby-preview` | redirect 302 | Manda a `/?lobby-preview`, el lobby realtime.         |
| `/game/:path*`           | redirect 302 | Manda a `/?lobby-preview`.                            |
| `/assets/(.*)`           | header       | `Cache-Control: public, max-age=31536000, immutable`. |
| `/_assets/(.*)`          | header       | `Cache-Control: public, max-age=31536000, immutable`. |

**Por qué redirect y no rewrite en `/game/:path*`:** el cliente decide la ruta
solo por query string (`isPreviewRoute()` lee `location.search`). Un rewrite deja
la URL del browser intacta, así que `?lobby-preview` nunca llegaría al cliente y
la app arrancaría el flujo legacy contra endpoints que no existen en Vercel. Un
redirect cambia la URL y el cliente sí lo ve.

**Rutas reales de assets:** el build emite los chunks JS en `/assets/` y todos los
assets públicos hasheados (imágenes, `lang/`, `maps/`) en `/_assets/`. No existe
`/maps/` en la raíz del sitio, por eso no hay header para esa ruta: quedaría
muerto. Los nombres de archivo llevan hash, de ahí el `immutable`.

### Ignorados

`.vercelignore` deja fuera `static/` (se regenera), `tests/`, `docs/`, `.github/`,
herramientas de container (`Dockerfile`, `nginx.conf`, scripts de deploy) y los
`.env` locales.

**No se ignora `resources/`, `packages/` ni `src/server/`:** el build los necesita
en el runner. `resources/maps/` en particular se copia a `static/_assets/maps/`
durante `vite build`; si se ignora, el sitio queda sin mapas. `src/server/` se usa
en el build por `RenderStaticIndex.ts` y por el manifest de `vite.config.ts`, no en
runtime.

---

## 3. Limitaciones

- **Refresh en medio de una partida**: `/game/<id>` no tiene shell propio en este
  deploy. Un refresh redirige a `/?lobby-preview` y se pierde la partida en curso.
  Es una limitación aceptada para F2: el estado vive en el cliente y no hay
  persistencia de partidas todavía.
- **Plan Hobby**: prohíbe el uso comercial. Si el juego deja de ser una herramienta
  interna sin fines de lucro, hay que pasar a Pro.
- **Plan Hobby y repos de organizaciones**: no se puede conectar un repo que
  pertenece a una organización de GitHub. El repo tiene que estar en una cuenta
  personal, o hay que usar Pro.
- **Submódulo `src/server/gatekeeper`**: apunta a un repo privado de OpenFront.
  El código compila sin él (`src/server/Gatekeeper.ts` cae en `noopGatekeeper`).
  Si el build falla intentando clonarlo, hay que dejarlo vacío o quitar el
  submódulo del fork.
- **Tamaño del repo**: el clon trae `resources/maps` y `proprietary`. El build
  estático pesa ~675 MB. Vercel no publica un límite de tamaño de output para
  builds desde Git: el límite de 100 MB de Hobby aplica solo a los source files
  de un deploy por CLI, y la doc de "Files" dice explícitamente que no hay tope
  para los archivos generados durante un build. El techo real es el build de 45
  minutos. Deployment Storage se mantiene a raya con la retención por defecto de
  30 días.
- **`api.<DOMAIN>` no existe en un deploy estático**: el cliente asume un backend
  HTTP en `https://api.<DOMAIN>` (`src/client/ApiBase.ts`) para auth y perfil. En
  Vercel ese subdominio resuelve por wildcard pero no tiene deployment detrás, así
  que cualquier `fetch` a él falla con `TypeError: NetworkError when attempting to
  fetch resource`. No bloquea el lobby realtime ni la partida (todo va por
  Supabase), pero cualquier reintento de auth falla en silencio. Si en F3 se
  quiere login real o perfiles, hay que separar la base de la API de `DOMAIN` o
  servirla en el mismo origen.
- **Sin `service_role`**: cualquier operación que necesite privilegios de Supabase
  tiene que resolverse con RLS y la clave publishable.

---

## 4. Deploy desde GitHub

1. Subir la rama `fase-2-red` al fork personal en GitHub.
2. En Vercel: **Add New → Project → Import Git Repository**.
3. Dejar **Framework Preset** en `Other`. `vercel.json` ya fija `framework: null`,
   `installCommand`, `buildCommand` y `outputDirectory`.
4. Cargar las variables obligatorias de la sección 1 (Preview y Production).
5. Deploy. La URL de producción sirve `/?lobby-preview` y `/` redirige ahí.
6. En Supabase, agregar el dominio de Vercel a los orígenes permitidos de
   Realtime.

Los deploys de preview heredan las mismas variables; si querés que un preview
apunte a otra instancia de Supabase, definí las `VITE_*` por entorno.

---

## 5. Verificación local (sin deploy)

Con el build ya hecho:

```sh
npx serve static -l 5000
```

Y comprobar:

- `http://localhost:5000/?lobby-preview` carga el lobby realtime.
- `http://localhost:5000/` redirige a `/?lobby-preview`.
- `http://localhost:5000/game/ABC123` redirige a `/?lobby-preview`.
- El thumbnail del mapa aparece en el lobby.
- La partida arranca (los workers del engine y del turn clock cargan).

`npx serve` no aplica `vercel.json`: los redirects y headers hay que probarlos en
un preview de Vercel.
