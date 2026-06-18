# Cartero para bots — notas de diseño

> Estado: **diseño / pensar-en-voz-alta**, no implementado. Este documento captura el
> análisis; no describe código existente salvo donde enlaza a archivos del árbol.
> Marca explícitamente qué se apoya en primitivas que **ya existen** y qué habría que
> **construir**.

Un bot en Cartero no es una entidad nueva a nivel protocolo: **es una identidad (una
llave) con un outbox (repo)**, igual que un humano. Cartero no distingue. Eso es lo que
hace el caso barato — la mayoría del trabajo es *recomponer* primitivas existentes, no
extender el protocolo.

---

## 1. Por qué encaja casi sin fricción

Ventajas que un bot hereda gratis de la arquitectura:

- **Sin aprobación de plataforma.** No hay API de WhatsApp/Telegram que aprobar, ni número
  que comprar, ni TOS que banee el bot.
- **Identidad verificable.** El usuario sabe que habla con *el* bot (firma ECDSA P-256), no
  con un impostor que clonó el nombre.
- **E2EE por defecto.** Bot ↔ usuario, nadie en el medio lee.
- **Handle `bot@dominio`.** Dirección legible y compartible.
- **Self-hosted y auditable.** El bot corre donde quieras; su historial es un repo git.

El `cartero watch` actual ([src/cli.js:171](../src/cli.js)) ya es, en esencia, medio bot:
poll cada 3s + suscripción al relay + dedupe.

---

## 2. Dos arquetipos (modelos de confianza opuestos)

La distinción más importante del diseño. No los mezclar.

### Arquetipo 1 — el agente como *peer*
El bot es **otra identidad** (su llave, su outbox). Vos le hablás como a cualquier
contacto: vos sellás a su llave, él sella a la tuya. DM normal de dos partes.

- **Confianza:** limpia. Dos identidades separadas. Si las dos llaves son tuyas, es como
  tener dos cuentas.
- **Ejemplos:** agente de soporte propio, asistente conversacional, bot de notificaciones
  (CI/alertas → tu DM).
- **Veredicto:** construible hoy sin tocar el protocolo. Es el caso a perseguir primero.

### Arquetipo 2 — gestión de *tu propia* bandeja
El bot actúa *sobre* tu bandeja: lee lo que otros te mandaron, clasifica, resume, responde
por vos. **Choca de frente con el E2EE:**

> Para que un bot lea tu bandeja, tiene que poder **descifrar lo que otros te sellaron a
> vos**. El contenido está sellado a *tus* llaves. Conclusión inevitable: **un bot que
> gestiona tu bandeja es, necesariamente, un dispositivo tuyo** (multi-device — la maestra
> le certifica una llave, los remitentes sellan a todas tus llaves, el bot puede leer).

Esto **ya lo soporta** la arquitectura multi-dispositivo, pero con tres consecuencias duras:

1. **El bot es vos, con acceso total.** No hay permisos granulares (read-only, scope por
   conversación). Tener la llave = leer todo y responder como vos.
2. **Sin acceso retroactivo.** Un bot agregado hoy **no** puede leer DMs sellados ayer
   (antes de existir su llave). La única salida es darle la **maestra** — y eso le da poder
   total, incluido certificar más dispositivos.
3. **Sin revocación por dispositivo todavía.** Si se compromete, rotás la identidad.

**Lo que faltaría para que el Arquetipo 2 sea bueno** (diseño futuro, no existe hoy):
permisos por dispositivo/capacidad, revocación por dispositivo, acceso a histórico
(re-sellado o uso de la maestra).

---

## 3. El runtime de bot: mapeo a primitivas existentes

El loop **recibir → procesar → responder** ya está disperso en la CLI. El runtime lo
recompone con una API de handlers.

| Necesidad del bot | Primitiva existente | Ubicación |
|---|---|---|
| Recibir (poll + push) | `cmdWatch`: `setInterval(tick,3000)` + `relaySubscribe` | [src/cli.js:171](../src/cli.js) |
| Dedupe de entrega | `const seen = new Set()` por `m.id` | [src/cli.js:174](../src/cli.js) |
| Descifrar lo recibido | `openDm(ev, identity)` → `{text, attachments, reply_to}` | [src/cli.js:188](../src/cli.js) |
| Validar antes de procesar | `verifyDm(ev, {directory})` | [src/cli.js:186](../src/cli.js) |
| Responder | `chainOf`→`buildDm`→`appendEvent`→`relayPublish` | [src/cli.js:126](../src/cli.js) |
| Ver todas las conversaciones | `cmdInbox` (`dmThread`/`groupThread`) | [src/cli.js:353](../src/cli.js) |

### API propuesta (boceto)

```js
const bot = await createBot({ home, pass, relay });   // carga identidad como context()

bot.onMessage(async (msg, ctx) => {
  if (!msg.readable) return;                           // 🔒 no era para esta llave
  await ctx.reply(`recibí: ${msg.text}`);
});

bot.command("/status", async (msg, ctx) => { /* ... */ });   // convención sobre onMessage

await bot.start();                                     // watch multi-contacto + relay
```

### Contrato `msg` / `ctx` (deriva de lo que `openDm` ya devuelve)

```
msg = {
  id,            // id del evento — clave de cursor y dedupe
  chat,          // chat_id (dm_…)
  from,          // id del remitente
  at,            // created_at ISO (auto-declarado: NO es reloj global)
  readable,      // false = no era para esta llave → ignorar
  text,          // contenido descifrado
  attachments,   // [{name,size,locator,key,hash}] — descarga con getBlob + cap
  reply_to,      // id al que responde (orden causal)
}

ctx = {
  reply(text, {file}={}),   // buildDm con reply_to=msg.id → appendEvent en SU outbox (+relay)
  send(to, text),           // iniciar/escribir a otro contacto
  identity, directory,
}
```

Decisión: `reply()` setea `reply_to = msg.id` **automáticamente** → el hilo queda encadenado
causalmente sin que la lógica lo piense. Correcto para soporte.

---

## 4. Los dos gaps reales

**Gap 1 — `watch` es por-contacto; el bot necesita escuchar a todos.**
`cartero watch <petname>` vigila *una* conversación. El bot necesita el loop sobre **todos**
sus chats. La agregación ya existe (`cmdInbox` recorre threads) pero **nadie la pone en
loop**. Trabajo de runtime, no de protocolo.

**Gap 2 — no hay "inbox de desconocidos" (el de más peso).**
En el modelo outbox, para leer lo que alguien te selló tenés que leer **su** outbox → tenés
que **conocer su outbox**. No existe buzón pasivo donde caigan mensajes de gente no agregada.

- **Agente de soporte privado:** ✅ no aplica — vos y el agente ya son contactos mutuos.
- **Bot público "cualquiera le escribe":** ⚠️ requiere construir un patrón:
  remitente empuja por **relay** → el evento trae `from` → el bot resuelve ese id en el
  **registry** (`id → outbox`) → lee su outbox y responde. Las piezas (relay + registry)
  existen; el "auto-add desde evento entrante" **no**.

---

## 5. Caso end-to-end: agente de soporte (Arquetipo 1)

### Topología — dos identidades espejadas

```
VOS (humano)                         AGENTE (bot)
home: ~/.cartero                     home: ~/.cartero-agent   (CARTERO_HOME distinto)
outbox: github.com/vos/inbox         outbox: github.com/vos/agent-inbox
token propio                         token propio (escribe SU repo)
leés el outbox del agente            lee tu outbox
escribís en tu outbox                escribe en su outbox
```

Cada lado **escribe solo en el suyo y lee el del otro**. La conversación es el merge.

### Setup (una vez, comandos existentes)

```bash
# 1. el agente crea SU identidad
CARTERO_HOME=~/.cartero-agent cartero init vos/agent-inbox --name "Soporte" --handle soporte@tudominio.dev
# 2. vos lo agregás
cartero contact add soporte@tudominio.dev soporte
# 3. el agente te agrega
CARTERO_HOME=~/.cartero-agent cartero contact add <tu-uri-o-handle> dueño
```

Desde acá son contactos mutuos y el DM sellado funciona en ambas direcciones.

### Ciclo de un mensaje

```
1. Vos:    cartero send soporte "no me anda X"
              └─ buildDm (sellado a la llave del agente) → commit en TU outbox
                 └─ (relay) relayPublish ───────────────┐
2. Agente: tick cada 3s lee TU outbox ── o ── push ←────┘
              └─ verifyDm → openDm → msg.readable?
                 └─ msg.id no en cursor → handler(msg, ctx)
3. Tu lógica corre (clasifica, consulta, arma respuesta)
4. ctx.reply("probá Y")
              └─ buildDm (sellado a TU llave, reply_to=msg.id) → commit en SU outbox → push
5. Agente: persiste cursor[chat] = msg.id
6. Vos:    cartero read soporte  → ves la respuesta (merge de ambos outboxes)
```

Latencia: ~2–5s sin relay, instantáneo con relay.

---

## 6. Estado e idempotencia (el único componente genuinamente nuevo)

Hoy el dedupe vive en un `Set` en memoria → al reiniciar, el agente **reprocesaría todo y
respondería dos veces**. Inaceptable para un bot. El runtime debe persistir un cursor en el
home del agente:

```
~/.cartero-agent/cursor.json   →   { "<chat_id>": "<último msg.id procesado>", ... }
```

Regla idempotente: procesar solo `msg.id` ausente del cursor; **persistir el cursor después
de que `reply()` confirmó el commit**. Si el agente muere entre handler y commit, reintenta
al arrancar — a lo sumo reprocesa uno, nunca pierde uno.

**At-least-once, no exactly-once.** Honesto: con git como transporte, exactly-once real no
se tiene. La lógica del handler debe tolerar reprocesar.

---

## 7. Límites operativos (heredados)

- **Rate limit GitHub (5000 req/h por token).** Soporte 1:1 → sobra. Bot multi-usuario activo
  → vigilar: cada `reply` es un commit, y el *poll* de N contactos cada 3s consume API aunque
  no haya nada nuevo. Mitigaciones de diseño: poll adaptativo (backoff en chats quietos) o
  depender más del relay para no quemar cuota en vacío. Para alto volumen real: git host
  propio (Gitea, sin esos límites).
- **El repo crece** (append-only): un agente que responde mucho infla su outbox → estrategia
  de poda/rotación eventual.
- **Latencia 2–5s** sin relay: perfecta para soporte, no para tiempo real estricto.
- **Disponibilidad:** el outbox del agente debe estar accesible cuando vos leés (inherente a
  la mensajería asíncrona, no específico de bots).

---

## 8. Decisiones abiertas (antes de construir)

1. **Token del agente:** repo separado (recomendado — aísla cuota y permisos) vs monorepo.
   → separado.
2. **Concurrencia:** handler en serie por chat (evita carreras en el cursor) vs paralelo.
   → serie por chat para soporte.
3. **Errores del handler:** no avanzar el cursor (reintento, coherente con at-least-once)
   vs avanzar y descartar. → no avanzar; exige idempotencia en la lógica.
4. **Forma de empaquetar el runtime:** módulo `src/bot.js` + un subcomando `cartero bot run`,
   o paquete/SDK aparte. (Sin decidir.)

---

## 9. Estado: echo-bot construido y validado

El **echo-bot mínimo** ya existe ([`src/bot.js`](../src/bot.js) + [`examples/echo-bot.mjs`](../examples/echo-bot.mjs)),
con cursor persistente. Probado offline ([`test/bot.test.mjs`](../test/bot.test.mjs), 10 checks,
en el gate) y end-to-end contra GitHub real (round-trip, ruteo `/ping`, idempotencia,
persistencia del cursor). El Arquetipo 1 está cerrado a nivel MVP; el Arquetipo 2 se detalla
en §11.

---

## 10. Resumen ejecutivo

- **Arquetipo 1 (agente peer):** construible hoy sin tocar el protocolo. Es ~90% recomponer
  `watch` + `send` + `openDm`/`inbox`; el único componente nuevo es el **cursor persistente**.
- **Arquetipo 2 (gestión de bandeja):** viable hoy **solo** aceptando que el bot = dispositivo
  tuyo con acceso total y sin histórico. Más que eso necesita capacidades que no existen
  (permisos finos, revocación, histórico).
- **Bots públicos:** requieren el patrón relay+registry para descubrir remitentes
  desconocidos (Gap 2).
- **No prometer** exactly-once, permisos granulares, ni acceso retroactivo: no existen.

---

## 11. Arquetipo 2 — diseño detallado (validado contra el árbol)

Un bot que **gestiona tu propia bandeja** (lee lo que otros te mandaron, clasifica, resume,
responde por vos) debe poder descifrar lo sellado *a vos* → es, necesariamente, un
**dispositivo tuyo** (multi-device, [`src/device.js`](../src/device.js)).

### Insight de base: leer y escribir YA están separados criptográficamente
- **Leer** = tener una enc key a la que el remitente selló → lo controla `recipientEncKeys`.
- **Firmar/responder como vos** = tener una sign key autorizada → lo controla `authorizedSignKeys`.

El cert de hoy ([device.js:20](../src/device.js)) emite **ambas** y `authorizedSignKeys` admite
la sign de todo cert válido. Es decir: **hoy todo device es read-WRITE**; no hay read-only. La
separación cripto existe, solo falta exponerla.

### Validación empírica (sonda descartable, no feature — 9/0 contra el código real)
| Afirmación | Resultado |
|---|---|
| Hoy todo device es read-write (su sign key se autoriza siempre; el gate acepta su firma como vos) | ✅ confirmado |
| Un device lee tu bandeja entrante (sellado a tu set incl. el bot) | ✅ |
| Sin acceso retroactivo: un msg sellado antes de existir el bot NO lo abre; vos (master) sí | ✅ |
| Camino B (re-sellado) es factible con `openAnonymous`+`sealAnonymous`; un tercero no lo abre | ✅ |

Lo que la sonda **no** probó porque **no existe en el código**: el campo `caps` (read-only) y la
revocación firmada. La sonda justamente expone el hueco (la sign se autoriza sin condición).

### Permisos por dispositivo
**Read-only es casi gratis**: certificar la **enc** key (lee) sin autorizar la **sign** key
(no responde como vos). Falta un campo de capacidad en el cert:
```
cert = { v, identity, name, device_sign, device_enc, caps:["read"], created_at, sig }
```
- `authorizedSignKeys`: agrega `device_sign` **solo si** `caps` incluye `"write"`.
- `recipientEncKeys`: agrega `device_enc` si incluye `"read"`.
- Default `["read","write"]` si `caps` ausente → retrocompatible. Toca `device.js`, no postal-core.

**Scope por conversación (leer solo el chat X): NO factible** por sellado público — el remitente
sella a *todo* tu set sin saber de tus chats. Limitar lectura por chat obliga a sacar la bot-key
del set público y re-sellarle selectivamente → converge con el histórico (Camino B).

### Acceso a histórico — tres caminos
| Camino | Da | Costo / confianza |
|---|---|---|
| **A. Bot en tu enc set** (multi-device de hoy + cap `read`) | Lee todo **desde su alta** | Sin histórico, sin scope, revocar-lectura imposible |
| **B. Re-sellado por el master** | Histórico **+ scope + revocación de lectura** | El master debe correr un proceso; duplica ciphertext |
| **C. Darle tu master enc key** | Todo, histórico y futuro | Cero granularidad: el bot **es vos** |

**Camino B** destraba todo a la vez: la bot-key NO está en tu set público (no recibe sellado
indiscriminado); vos (master) abrís los mensajes elegidos y los **re-sellás** a la bot-key en un
buzón que el bot lee. "Qué re-sellás" = scope; "dejás de re-sellar" = revocación de lectura
inmediata. Costo: el master debe estar corriendo el re-sellado + storage duplicado, y el
`tickContact` del bot leería el **buzón re-sellado** en vez de los outboxes de los peers.

### Revocación por dispositivo
- **Firma:** hoy = quitar el cert del set publicado (insuficiente: re-publicar el cert lo
  revive). Falta una **revocación firmada** por el master con `revoked_at`; el gate rechaza
  eventos de esa key **posteriores** a ese instante (los viejos siguen válidos — son historial).
  Toca el gate (`verifyDm`/`signingKeyOf`).
- **Lectura:** **no es retroactiva** — lo ya sellado a una key es legible para siempre por quien
  la tenga. Lo único honesto: dejar de sellarle. Con Camino B es inmediato; con Camino A, lo
  sellado durante su vigencia queda legible aunque quites el cert.

### Recomendación
- **Asistente que clasifica/resume desde que lo activás** → **Camino A + cap `read`**. Cambio
  chico, sin histórico, suficiente para la mayoría. Construir primero.
- **Asistente con scope estricto / histórico / revocación de lectura real** → **Camino B**
  (cripto ya validada; falta proceso master + buzón + ajuste de `tickContact`).
- **Camino C** solo si confiás en el bot como en vos mismo y no te importa histórico ni revocar.

### Qué tocaría (todo cartero, nada postal-core)
`device.js` (`caps` + condicionar sign/enc + lista de revocación firmada) · gate
(`verifyDm`/`signingKeyOf`: chequear `revoked_at`) · (Camino B) módulo de re-sellado del master
+ `bot.js` `tickContact` leyendo el buzón re-sellado.
