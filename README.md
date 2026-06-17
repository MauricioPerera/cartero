# Cartero

**Mensajero E2EE soberano sobre git**, construido sobre el protocolo
[postal](https://github.com/MauricioPerera/postal) (submódulo en `vendor/postal`).
Tu identidad es una **clave**, tu buzón es un **repo git** que podés migrar, y cualquier
cliente que hable el protocolo sirve. Sin servidor de mensajería, sin número de teléfono,
sin proveedor que te pueda banear sin que te lleves todo.

MVP (F1): **DM 1:1**, **texto + adjuntos** (imagen/documento), asíncrono (polling), cliente CLI.
El contrato está en [`SPEC-F0.md`](SPEC-F0.md).

## Cómo funciona (en una línea)

Cada quien escribe **solo su propio outbox** (un repo), sellando cada mensaje a su par; la
conversación es el **merge de los dos outboxes**. Los adjuntos van cifrados y direccionados por
hash **afuera** del evento (en `blobs/`); el evento firmado lleva solo el descriptor, sellado.
El orden entre las dos partes es **causal** (`reply_to`), no total — no hay secuenciador único.

## Uso (CLI)

```bash
# secretos por entorno
export GH_TOKEN=$(gh auth token)      # token con acceso al repo (escritura a TU outbox)
export CARTERO_PASS=<tu-passphrase>   # cifra tu identidad en reposo (~/.cartero)

cartero init <owner/repo> --name "Alice"     # crea identidad + outbox, imprime tu URI
cartero init <owner/repo> --handle alice@perera.dev   # + emite el binding firmado para tu dominio
cartero contact add <uri | user@domain> bob  # resuelve+verifica (URI o handle), guarda "bob"
cartero send bob "hola 👋" [--file ./doc.pdf] # envía un DM sellado (con adjunto opcional)
cartero read bob [--save ./descargas]        # imprime la conversación (merge de ambos outboxes)
cartero watch bob                            # poll cada 3s + relay (instantáneo) por defecto
cartero send bob "hola"                       # commitea a git Y reenvía por el relay (default)
#   relay por defecto: https://cartero.ardf.dev · cambialo con --relay <url> o $CARTERO_RELAY · --no-relay lo desactiva
```

`CARTERO_HOME` separa estados locales (útil para probar varias identidades en una máquina).

## UI web

Un cliente de navegador para DMs: `node web/server.mjs` → http://localhost:8765. El navegador
hace **todo** (genera la identidad, firma/sella, habla con GitHub con tu token y con el relay);
el server solo sirve archivos estáticos y no guarda secretos. Reusa los mismos módulos
(`src/convo.js`, `src/outbox.js`, `src/attach.js`) que el CLI — son browser-compatibles. Setup
con token + outbox, agregás contactos por URI, enviás/recibís DMs (con adjuntos), y el relay da
entrega instantánea. *MVP:* la clave privada y el token viven en `localStorage` (riesgo de XSS;
usá un token de alcance mínimo).

### Handles `user@domain` (F2)

Una dirección legible y dable, estilo email, resuelta WebFinger: `cartero init --handle alice@perera.dev`
emite un **binding firmado** que publicás en `https://perera.dev/.well-known/postal/alice.json`.
Doble atestación: el **dominio** lo sirve (TLS = control del dominio) y la **clave** lo firma
(consiente el binding `handle ↔ id ↔ outbox`). Debajo la identidad sigue siendo la clave, así que
el handle es un **alias portable y desechable**. Otros te agregan con `cartero contact add alice@perera.dev`.

### Relay para inmediatez (F2b, opcional)

Sin relay la entrega es asíncrona (2–5 s por poll). Con un **relay** (`src/relay.js`, un
reenviador **no-confiable**): `send --relay <url>` commitea a git **y** reenvía el evento al
instante; `watch --relay <url>` se suscribe (SSE) y muestra lo nuevo en sub-segundo. El relay
**nunca descifra** (ciphertext) y **no gana autoridad**: el receptor corre el gate en cada evento
relayado, así un payload forjado se rechaza igual que uno leído de git. Git sigue siendo el
registro durable. *(Disparar la entrega desde un push de git —webhook GitHub→relay— necesita el
relay en una URL pública + HMAC del secreto: queda para hosting, no incluido.)*

## Verificación

- **Núcleo en memoria** (`test/cartero.test.mjs`, 26/0): roundtrip sellado (el par lee, un
  tercero no), gate (firma/`chat_id`/self-dm/autor), adjuntos (hash-verificados), merge causal,
  append-only, evento forjado descartado.
- **End-to-end sobre git real** (`test/integration.test.mjs`, 8/8): dos outboxes reales, publicar
  identidad, enviar texto + adjunto, leer el merge, descargar y descifrar el adjunto.

```bash
npm test                                                # núcleo (sin red)
GH_TOKEN=$(gh auth token) GH_OWNER=<o> GH_REPO_A=<a> GH_REPO_B=<b> \
  node test/integration.test.mjs                        # integración (red)
```

### Grupos (F3 — núcleo)

Un grupo es un **doc firmado por el creador** (`{ id, name, creator, members[], sig }`); los
mensajes (`kind:"gm"`) van **sellados a todos los miembros** y cada uno postea a **su propio
outbox** bajo el id del grupo (federado, sin escritura compartida); leer = el merge de los
outboxes de los miembros. Probado (`test/group.test.mjs`, 15/0): doc firmado, sellado a N (todos
leen, un tercero no), gate (no-miembro / grupo-equivocado), merge causal, miembro removido
descartado. *Límites:* membresía gestionada por el creador (sin quórum), sin forward secrecy al
remover.

```bash
cartero group create proyecto bob carol     # crea el grupo con tus contactos, publica el doc firmado
cartero group join <creator-uri> <group-id> # un miembro se une (baja+verifica el doc del outbox del creador)
cartero group send proyecto "hola" [--file] # mensaje sellado a todos los miembros
cartero group read proyecto                 # merge de los outboxes de todos los miembros
```

Falta de F3: multi-dispositivo (sub-claves por dispositivo) y la UI.

## Límites honestos (MVP)

Metadatos no ocultos (el sobre expone `from`/`to`) · una clave por dispositivo · handles
`@dominio` y relay/tiempo-real en fases siguientes · `created_at` auto-aseverado, orden **causal**
entre partes. Ver `SPEC-F0.md §11`.
