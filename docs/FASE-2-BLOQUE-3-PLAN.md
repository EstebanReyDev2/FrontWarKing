# Fase 2 — Plan de Bloque 3

**Estado:** aprobada para implementación con los ajustes del usuario; no implementada.  
**Base:** F2a-5 (`9ca59f8bd`) y F2a-6 (`758fd68b6`) ya integran el transporte Supabase Broadcast, `RealtimeSession` y la fachada `Transport`.

## 1. Alcance propuesto

El documento original ubicaba en el Bloque 2 el “adaptador real + `RealtimeSession` + `Transport` + lobby” (§14). Los dos primeros componentes de red ya están implementados en F2a-5/F2a-6. Por lo tanto, el trabajo restante de ese alcance debe delimitarse como **lobby mínimo + decisión explícita de identidad**, no como una nueva implementación del transporte o de la sesión.

El §4.11 de `FASE-2-DISENO.md` llama a esto lobby mínimo de F2a: crear una sala con código de 4–6 caracteres y enlace, mostrar jugadores, permitir que sólo el host empiece y fije `gameStartInfo`, y asignar `persistentID` local más apodo. El lobby aún no está cubierto por F2a-5/F2a-6.

### Incluye

- Crear sala efímera y compartir código/enlace de invitación.
- Código de sala de 6 caracteres, generado con `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`; al unirse, normalizar con uppercase + trim + quitar espacios.
- Entrar con código, mostrar roster y apodos, manejar duplicados y sala llena. `MAX_PLAYERS = 7` (host + 6 compañeros); 8 es el techo absoluto, nunca 20.
- Join con handshake: si el peer no recibe `hello` de vuelta del host en `JOIN_TIMEOUT_MS = 3000`, mostrar “Sala no encontrada o host desconectado”.
- Mantener un único host fijo durante el lobby; sólo él puede empezar.
- Al empezar, congelar un roster canónico, producir `gameStartInfo` y pasarlo a la sesión F2a existente.
- Cerrar el lobby en los clientes si el host sale o desaparece antes de empezar; pedir que creen otra sala, no elegir un host nuevo.
- No admitir peers nuevos después de empezar la partida; mostrar “Partida ya iniciada”. Rejoin mid-game de un peer ya conocido sigue siendo responsabilidad de `RealtimeSession`.
- Documentar el modelo de identidad, los límites de abuso aceptados y los canales de Supabase usados.

### No incluye

- Nuevo transporte, orquestador de sesión o API de partida.
- Persistencia de salas, historial, resultados o cuentas.
- Elección de host del lobby, failover de partida, votación o quórum.
- Features de juego o cambios al engine.

## 2. Identidad de invitado: opciones y recomendación

| Opción                                                             | Ventajas                                                                                                                                                                     | Costos y riesgos                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. `persistentID` en `localStorage` + código de sala; sin Auth** | Flujo inmediato, sin PII, encaja con el diseño de §4.11 y la identidad local ya usada por el cliente. No crea filas de usuario en Auth.                                      | Identidad reiniciable al borrar datos o cambiar de navegador; no prueba que alguien sea quien dice ser. Un `persistentID` y el código son identificadores, no credenciales. Canales públicos permiten que cualquiera con la clave publicable y el topic participe si conoce/descubre la sala. No hay rate limit de lobby confiable en el cliente. |
| **B. Supabase Anonymous Auth**                                     | Emite un UID/JWT por visitante y permite usar canales privados con RLS sin solicitar correo ni contraseña. Puede limitar acceso a topics/acciones usando claims y políticas. | Agrega onboarding y estado de Auth; al salir, limpiar datos o usar otro dispositivo, la identidad anónima no se recupera. Se crean usuarios persistidos en `auth.users`, requieren limpieza; la protección anti-abuso de sign-up y CAPTCHA agrega configuración. No equivale a una identidad recuperable.                                         |
| **C. Supabase Auth completo**                                      | Identidad recuperable y persistente entre dispositivos; apropiado si más adelante hacen falta cuentas, moderación o permisos durables.                                       | Pide proveedor/PII o un flujo de login y aumenta alcance, soporte y políticas de privacidad. Es trabajo de Fase 3 y contradice el objetivo actual de no tener cuentas públicas.                                                                                                                                                                   |

**Recomendación para este juego interno:** opción A para el lobby inicial, con `persistentID` aleatorio generado localmente, apodo, y código de sala aleatorio de **6 caracteres** (usar los 4–6 del diseño sólo si se decide aceptar menor espacio de códigos). No guardar email ni información personal. Tratar el ID y el room code como routing, no como autenticación ni secreto de seguridad. Si el usuario exige que sólo integrantes admitidos puedan escuchar o publicar, elegir B antes de construir el lobby y definir RLS en `realtime.messages`; no intentar simular autorización con IDs del cliente.

Los usuarios anónimos de Supabase usan el rol `authenticated`, llevan claim `is_anonymous` y no pueden recuperar la misma identidad tras sign-out, borrar datos o cambiar de dispositivo. Supabase recomienda CAPTCHA/protección anti-abuso para sign-ups anónimos y no dispone de limpieza automática de esos usuarios; valorar estos costos antes de elegir B ([Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous)).

## 3. Roster autoritativo y host antes de empezar

- **Autoridad:** el creador es el host del lobby y es la única autoridad de roster en F2a. El cliente host decide admisión, unicidad de `persistentID`, límite de jugadores y orden de slots; el orden del roster se congela una sola vez al pulsar **Empezar** y todos reciben el mismo `gameStartInfo`.
- **Consistencia:** cada mensaje de lobby lleva `roomID`, `hostID`, `lobbyEpoch` y secuencia/version del roster. Repeticiones idempotentes no agregan miembros duplicados. Un `start` incluye el roster final; no se empieza con un roster parcial o con joins aún sin confirmar.
- **Salida del host antes de empezar:** el roster no se transfiere. Los clientes esperan el lease/heartbeat ya definido y muestran “el host cerró la sala; crea una nueva”. El lobby queda cerrado y se vuelve al inicio. La reelección previa al juego es failover y queda fuera de este bloque; no se mezcla con el protocolo F2b.
- **Salida del host después de empezar:** se mantiene el comportamiento F2a actual: fin claro de partida; no hay failover.
- **Límite de confianza:** con Broadcast público, un cliente modificado podría imitar identidad o publicar un roster distinto. El host reduce errores accidentales, pero no crea una frontera de seguridad. La validación autoritativa fuerte requiere autenticación/políticas o backend.

El `persistentID` no debe reemplazar el índice del roster como prioridad futura de elección: el diseño de F2b ya fija el orden de roster como referencia común y estable (§4.3).

## 4. Creación, vida y limpieza de salas huérfanas

### Alternativas

1. **Sala efímera sólo por Broadcast (recomendado para este alcance):** no hay fila de room ni directorio global. El host anuncia sala y roster por canal, emite heartbeat mientras la mantiene abierta y los clientes dejan de mostrarla al vencer el lease. Al desconectarse todos, el canal deja de tener participantes; no hay registro persistente que barrer. El link/código compartido por el host es la vía de descubrimiento.
2. **Tabla `rooms` con `expires_at` + tarea programada:** permite lookup y limpieza central, pero introduce persistencia/RLS y un proceso programado. Un `expires_at` por sí solo **no elimina** filas: necesita cron/pg_cron, una tarea externa o un barrido oportunista.
3. **`lastSeenAt` + barrido de clientes:** no requiere scheduler, pero los clientes pueden cerrarse antes de barrer, competir por borrar registros o borrar una sala todavía activa con reloj atrasado. No es una garantía de limpieza.

**Recomendación:** opción 1; no persistir lobby en DB en F2a. La aplicación debe cerrar su estado local con heartbeat/timeout y tratar el canal como efímero. Si una sala visible/desconectada entre sesiones pasa a ser requisito, decidir primero una tabla y un mecanismo de expiración programado; no llamar “TTL” a una marca de tiempo sin borrador real.

## 5. Rate limiting de create/join sin Edge Functions

Sin una autoridad server-side, cualquier límite implementado sólo en JavaScript es eludible por un cliente modificado. Para el lobby pequeño y privado se propone una defensa **best effort**, no un control anti-abuso:

- Debounce de botones y cooldown local (si se implementa): sugerencia inicial de 1 creación cada 10 s y máximo 3 intentos de join en 30 s por pestaña. El comentario en código y este plan deben decir literalmente: “cooldown client-side, no protege contra abuso, protege contra doble-click accidental”. No hay rate limiting server-side.
- Room code aleatorio de 6 caracteres, comparación en tiempo constante si se valida localmente, y errores uniformes para evitar filtrar si una sala existe.
- Host limita roster a 20 jugadores y descarta mensajes repetidos por `persistentID`/secuencia.
- Sin búsqueda/listado público de salas ni Presence usado como autoridad.
- Exponer métricas/errores del servicio y aplicar backoff; no reintentar create/join en loop.

Estas reglas no dan cuota por IP/usuario y se reinician al cambiar de perfil o manipular el cliente. Las cuotas del proveedor son protecciones de capacidad, no cuotas específicas del lobby: Supabase publica actualmente para Free hasta 200 conexiones concurrentes, 100 eventos/s, 100 joins/s y 100 canales por conexión. Un evento cuenta como mensaje enviado o entregado; un broadcast a muchos suscriptores se multiplica por las entregas. Los límites no reemplazan autorización ni anti-spam ([Realtime Limits](https://supabase.com/docs/guides/realtime/limits)).

Con 20 jugadores, el broadcast de 5 batches/s puede acercarse por sí solo a 95 entregas/s, antes de intents, acknowledgements y lobby. Varias partidas simultáneas pueden exceder el límite Free; verificar el smoke real con la concurrencia prevista antes de declarar suficiente el presupuesto.

## 6. Canales, RLS y seguridad

- **Canales públicos:** el cliente sólo necesita la clave publicable, pero cualquier persona que tenga esa clave puede escuchar/publicar en un topic público si lo conoce. El código de sala no es control de acceso. No usar canales predecibles como único secreto.
- **Canales privados:** Supabase exige que el cliente se autentique y valida joins contra políticas RLS de `realtime.messages`; cada join implica autorización. Esto requiere opción B o C, además de políticas explícitas para que miembros del room puedan leer y publicar sólo en sus topics.
- **Presencia:** puede mejorar una indicación visual del roster, pero no debe decidir host, admisión definitiva ni quórum.
- El límite de Broadcast publicado por Supabase Free es 256 KB; el protocolo de F2a usa chunks menores y no cambia en el lobby.

El setting actual de Supabase permite por defecto canales públicos; al deshabilitar acceso público todos los clientes deben usar `config.private` y pasar autorización RLS. La documentación advierte que cualquiera con la clave publicable puede usar canales públicos ([Realtime Settings](https://supabase.com/docs/guides/realtime/settings)).

## 7. Fuera de alcance explícito

- **F2b:** elección de host, `HostAuthority`, términos nuevos, votación/quórum, sincronización entre pares y failover. Si el host cae en F2a, la partida termina.
- **F2c:** hardening, reenvío fiable de intents, refresh/catch-up del engine con optimización, manejo avanzado de particiones y topes extra.
- **F2d:** despliegue estático Vercel y configuración de entorno de producción.
- **Features de juego:** economía, recolección, edificios productores, eras/tecnologías, unidades, fortificaciones, civilizaciones y alianzas **siguen fuera de F2**. F2 sólo reemplaza red/sesión/lobby; el juego sigue siendo OpenFront con Supabase hasta que se implementen explícitamente F3–F7.
- Un peer nuevo no puede entrar a una partida ya iniciada (late join desde mitad de partida fuera de B3); sólo se conserva el rejoin de un peer previamente conocido que ya soporta `RealtimeSession`.
- Cuentas, perfiles durables, ranking, moderación, bans, salas públicas, persistencia de partidas y reaping de filas (si no hay tabla de rooms).

## 8. Riesgos abiertos

1. **Broadcast público vs RLS:** sin Auth, el cliente no puede garantizar que un join provenga de quien recibió el enlace. Con Auth anónimo, se necesita política RLS, CAPTCHA y limpieza de usuarios.
2. **Identidad entre sesiones:** `localStorage` sobrevive recargas en el mismo perfil, pero no es identidad recuperable ni verificable; Anonymous Auth tampoco sobrevive a pérdida de sus credenciales.
3. **Host que se va antes de empezar:** sin rehost, toda la sala se descarta y los compañeros deben crear otra. Confirmar que esta UX es aceptable.
4. **Reaping:** no hay problema de filas huérfanas si no se crean filas; si se agrega tabla, TTL requiere un scheduler real.
5. **Capacidad Free:** broadcasts se cuentan por entrega, no sólo por publicación. Una partida de 20 y varias simultáneas pueden superar 100 eventos/s; los límites exactos dependen del plan activo y deben verificarse en dashboard/uso real.
6. **Código de sala corto:** seis caracteres bajan probabilidad de colisión frente a cuatro, pero no son autenticación. Un listado o enumeración de topics ampliaría el riesgo.

## 9. Prerequisitos para aprobar entrada a implementación

- [ ] El usuario informa aprobado el smoke real, ejecutado por él (no por este agente), y las dos pestañas de desarrollo completan el flujo.
- [ ] La baseline nueva queda registrada en Engram como **6499 passed / 81 failed / 1 skipped**, delta `+18` tests frente a `6481` pre-F2a-5; no modificar los dos archivos de baseline. Los 81 fallos y 2 flaky son los mismos.
- [ ] El usuario decide el Punto 2 (adelgazamiento del build) con las mediciones del build y acepta o rechaza las podas propuestas.
- [ ] El usuario aprueba este plan y, en particular, opción de identidad, canales públicos/privados, expiración de host y comportamiento al perder el host antes de empezar.

## 10. Decisiones solicitadas en review

1. ¿Confirmamos que Bloque 3 sea sólo lobby mínimo e identidad, dejando el transporte y la sesión fuera porque ya están implementados?
2. ¿Aceptamos identidad A (`localStorage` + room code) y canales públicos por el alcance interno del juego, o preferimos B y RLS desde el inicio?
3. ¿Aceptamos que si el host cierra el lobby antes de empezar todos vuelvan al inicio y creen una sala nueva?
4. ¿Mantenemos salas efímeras sin tabla ni proceso de reaping?

**No ejecutar Bloque 3 hasta recibir aprobación explícita.**

## 11. Aprobaciones y proceso de implementación

- El usuario aprobó identidad `persistentID` en `localStorage` + código de sala + apodo, sin Supabase Auth, y canales públicos.
- El usuario aprobó los ajustes: `MAX_PLAYERS = 7` (8 techo absoluto), código de 6 chars con charset no ambiguo, handshake de join con timeout de 3 s, cooldown sólo client-side con comentario explícito, y no admitir late join de peers nuevos.
- B3-1 y B3-2 se implementan y commitean seguidos. Al terminar B3-2, frenar para que el usuario pruebe el lobby con datos fake; informar capturas/flujo y esperar OK antes de B3-3.
- B3-3 y B3-4 pueden seguir en secuencia si no surge ambigüedad ni cambio de baseline. Al completar Bloque 3, esperar aprobación explícita antes de F2d.
