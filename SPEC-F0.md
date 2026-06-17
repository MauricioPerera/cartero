# Cartero — Spec F0 (contrato del MVP)

> Mensajero **E2EE soberano sobre git**, construido sobre el protocolo **postal**
> (consumido como submódulo, nunca reimplementado). Esta spec es el **contrato**:
> formas de evento, identidad, URI y canonicalización. El código de F1 cuelga de acá.

## 0. Alcance congelado (MVP)

- **DM 1:1** (sin grupos), **texto + adjuntos limitados** (imagen / documento).
- Identidad = **clave**; se comparte por **URI**; se verifica por **huella**; se nombra con **petname** local.
- Entrega por **polling** (2–5 s); sin relay.
- Cliente de referencia: **CLI**.
- Almacenamiento: **outbox por usuario** (cada uno escribe su propio repo git privado; el otro pullea). Host inicial: GitHub, con la abstracción multi-host de postal lista → self-host es config.

Fuera de F0/MVP: grupos · relay/real-time · handles `@dominio` · multi-dispositivo · UI · federación con registro · voz/video.

## 1. Qué se reusa de postal (no se redefine)

- **Identidad** (`users/<id>.json`): dos claves P-256 (sign ECDSA, enc ECDH); `id` = primeros 64 bits de `SHA-256(sign_pub)`; auto-firma; cadena `rotations` con ventanas de clave/revocación.
- **Evento firmado**: `{ v, kind, chat_id, from, to, created_at, id, seq, prev, body, sig }`. `id` y por ende el **path es determinista**.
- **Sellado** (E2EE): clave de contenido AES-256-GCM, envuelta por-destinatario vía ECDH efímero-estático; AAD = metadatos del evento; cuerpo → `{ sealed: "POSTAL1:<base64>" }`.
- **Gate** (`verifyEvent`): forma, path determinista, firma, ventana de clave, cadena (`seq`/`prev`), append-only.
- **Cadena por autor** (`seq`/`prev`) — orden a prueba de manipulación *dentro* de un autor.
- **Patrón hash-anclado** (`postal-audit`): commitear el hash en el evento firmado; los bytes viven afuera; cualquier cambio se detecta.

## 2. Identidad y la URI compartible

Cada usuario tiene **un outbox** = un repo git con su identidad publicada en `.postal/users/<id>.json`. El doc de identidad de postal se extiende con **un campo**:

```json
{ "...campos de postal...", "outbox": "postal://github.com/<owner>/<repo>" }
```

`outbox` declara, **firmado por la propia clave**, dónde vive el feed — así el localizador es auto-aseverado por el dueño (no por el host).

**URI compartible** (lo que ponés en una tarjeta / QR):

```
postal://<host>/<owner>/<repo>#<huella>
ej: postal://github.com/mauricio/cartero-outbox#A1B2C3D4E5F60718
```

- `<host>/<owner>/<repo>` → el outbox (dónde).
- `#<huella>` → el `id` esperado (quién), para verificar.

**Resolución:** traer `.postal/users/<huella>.json` del repo → `verifyIdentityDoc` (id ancla a la clave génesis + auto-firma válida) → confirmar que `id == huella`. Si pasa, tenés su clave (para sellar/verificar) y su outbox (para pullear). La **huella se confirma fuera de banda** (TOFU) antes de confiar.

## 3. La conversación 1:1 (`chat_id` derivado)

No hay `meta.json` ni eventos `member`: en un DM la **membresía es estructural**, los dos participantes son las dos claves. El `chat_id` se **deriva determinísticamente** de ambos `id` (los dos lo computan sin coordinar):

```
chat_id = "dm_" + hex(SHA-256(sort([idA, idB]).join("|"))).slice(0, 32)
```

Se **hashea** para que un observador con acceso de lectura no lea los participantes en el **nombre del directorio**. (Límite honesto en §11: los campos `from`/`to` del evento **no** van sellados, así que quien abra un evento igual ve quién habla con quién — el hash sólo evita el leak a nivel de path.)

Cada autor escribe **su mitad** de la conversación en **su propio outbox**, bajo el mismo `chat_id`. El cliente **fusiona** los eventos de ambos outboxes bajo ese `chat_id`.

## 4. Evento DM (`kind: "dm"`)

```json
{
  "v": 1,
  "kind": "dm",
  "chat_id": "dm_9f86d081884c7d65...",
  "from": "<id del emisor>",
  "to": ["<id del par>"],
  "created_at": "2026-06-17T20:00:00.000Z",
  "id": "2026-06-17T20-00-00-000Z_<from>_<rnd>",
  "seq": 0,
  "prev": null,
  "body": { "sealed": "POSTAL1:<base64>" },
  "sig": "<ECDSA sobre canonical(evento sin sig)>"
}
```

- `to` tiene **exactamente un** id (el par).
- `id`, y por ende el **path** `.postal/chats/<chat_id>/events/YYYY/MM/DD/<id>.json`, es determinista (convención de postal).
- `seq`/`prev` = cadena por-autor-por-chat (cada uno encadena solo su propia mitad en su repo).

**Cuerpo en claro (antes de sellar):**

```json
{
  "text": "hola 👋",
  "reply_to": "<id de un evento previo | null>",
  "attachments": [ /* §6, [] si no hay */ ]
}
```

## 5. Sellado E2EE

El cuerpo se **sella a `[from, to[0]]`** (emisor **y** par), así el emisor puede releer lo que mandó. Mecánica idéntica a postal: clave de contenido AES-256-GCM, envuelta por-destinatario (ECDH efímero-estático), AAD = metadatos del evento (el sobre no se puede reubicar a otro evento/chat). Resultado: `body = { sealed: "POSTAL1:..." }`. Se **sella y luego se firma**: la firma cubre el ciphertext.

## 6. Adjuntos (descriptor firmado + blob cifrado afuera)

El binario **no** va en el evento. Va cifrado y direccionado por contenido; el evento lleva solo el **descriptor**, dentro del cuerpo **sellado** (así hasta el nombre/tipo del archivo queda E2EE).

**Al enviar un archivo:**
1. `K` = clave AES-256-GCM aleatoria (por archivo).
2. `ct = AES-256-GCM(K, bytes)` (con su nonce).
3. `hash = SHA-256(ct)` (hex).
4. Guardar `ct` en `blobs/<hash>` del **outbox del emisor** (MVP; store enchufable después).
5. Descriptor en `body.attachments[]`:

```json
{
  "name": "factura.pdf",
  "mime": "application/pdf",
  "size": 84213,
  "hash": "<sha256(ct) hex>",
  "key": "<K en base64>",
  "locator": "blobs/<hash>",
  "thumb": "<base64 de un thumbnail cifrado | null>"
}
```

`K` viaja **dentro del cuerpo sellado** (ya E2EE). El blob es **ciphertext** verificado por `hash`, así que el store es **no-confiable**.

**Al recibir:** desellar cuerpo → leer descriptor → traer `locator` del outbox del emisor → verificar `SHA-256(ct) == hash` (integridad) → descifrar con `K`. Límite **enforced**: 8 MB por defecto (configurable con `--max-mb` / `$CARTERO_MAX_ATTACH_MB`); los blobs van directo al host git, así que un archivo sin tope inflaría el repo.

## 7. Canonicalización (NORMATIVA, fijada en F0)

Para firmar y para `hash` de payloads se usa la forma canónica de la implementación de referencia de postal (`crypto.canonical`): **claves ordenadas lexicográficamente, recursiva, `JSON.stringify` para primitivas, sin espacios**. Dos clientes interoperan **solo** si canonicalizan idéntico. F0 **congela esta forma como el contrato**; alinearla formalmente a **JCS / RFC 8785** + vectores cross-lenguaje es roadmap (no bloquea el MVP de un solo cliente).

## 8. El gate de Cartero (sobre `verifyEvent`)

Un evento DM es válido sii pasa `verifyEvent` de postal **y además** (reglas de Cartero):

1. `kind === "dm"`.
2. `to.length === 1` y `from !== to[0]`.
3. `chat_id === derive(from, to[0])` (§3) — ata el evento a su conversación.
4. `from` y `to[0]` son las **dos** identidades que derivan ese `chat_id`.

No hay eventos `member` ni replay de gobernanza: la autorización es **estructural**. Un evento que falla cualquier regla **no se muestra** (igual que en postal: se conserva con veredicto para diagnóstico, un cliente real no lo renderiza).

## 9. Resolución de la conversación (merge + orden)

Dada **mi identidad** + un **contacto** (su `id` + `outbox`):

1. `chat_id = derive(yo, ellos)`.
2. Pullear `.postal/chats/<chat_id>/events/**` de **ambos** outboxes (el mío y el del par).
3. Correr el **gate** (§8) en cada uno; descartar fallos.
4. **Desellar** los cuerpos (puedo descifrar los que están sellados a mí: mis enviados —me sellé a mí— y los suyos hacia mí).
5. **Fusionar** y ordenar con `canonicalOrder` de postal. **Sin orden de commit global** entre dos repos → cae a `created_at` + `id`, con `reply_to` aportando orden **causal** (happened-before). Es el límite estructural de la federación (no hay secuenciador único entre partes).

## 10. Estado local del cliente

- **Identidad** en `~/.cartero/identity.json` — contiene las **claves privadas**; en F1 debe ir **cifrada con passphrase** (en F0 se especifica el requisito, no la impl).
- **Contactos/petnames** en `~/.cartero/contacts.json`:

```json
{
  "Mauricio": {
    "id": "A1B2C3D4E5F60718",
    "uri": "postal://github.com/mauricio/cartero-outbox#A1B2C3D4E5F60718",
    "verified": true,
    "verified_at": "2026-06-17T20:00:00.000Z"
  }
}
```

El **petname** es local y elegido por el usuario; la **confianza** nace de verificar la **huella** OOB (campo `verified`).

## 11. Límites honestos / fuera de alcance

- **Metadatos no ocultos.** El sobre firmado expone `from`/`to` (los necesita el gate y el sellado). Hashear el `chat_id` evita el leak en el path, pero abrir un evento revela quién habla con quién. Ocultar el **grafo social** (no solo el contenido) requiere más (repos por-conversación con ACL, mixnet) → fuera de alcance.
- **Una clave por dispositivo.** Multi-dispositivo (sub-claves atestadas bajo una identidad) → F3.
- **Orden total entre partes no existe** sin secuenciador; se asume orden **causal**.
- **Borrado de blobs:** posible (viven afuera, con ciclo de vida); el evento conserva el `hash` como registro de que existió. El store enchufable y su GC → post-MVP.
- **Handles `@dominio`** (resolución vía `.well-known` firmado) → F2; en MVP se comparte la **URI**.
- **Disponibilidad:** si el par está offline, la entrega espera en su outbox (asíncrono, como email). Ser un nodo 24/7 alcanzable es decisión de hosting (GitHub o self-host), no del protocolo.

---

### Resumen del contrato

Identidad postal **+ `outbox`** · URI `postal://host/owner/repo#huella` · conversación `chat_id = dm_hash(ids)` · evento `kind:"dm"` con cuerpo **sellado** `{text, reply_to, attachments}` · adjuntos **hash-anclados** con blob cifrado afuera · **canonicalización congelada** · gate = `verifyEvent` + 4 reglas estructurales · lectura = **merge de dos outboxes** con orden causal. Todo lo demás es F1+.
