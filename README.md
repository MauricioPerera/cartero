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
cartero contact add <uri-del-par> bob        # resuelve+verifica, guarda el petname "bob"
cartero send bob "hola 👋" [--file ./doc.pdf] # envía un DM sellado (con adjunto opcional)
cartero read bob [--save ./descargas]        # imprime la conversación (merge de ambos outboxes)
cartero watch bob                            # poll cada 3s, imprime lo nuevo
```

`CARTERO_HOME` separa estados locales (útil para probar varias identidades en una máquina).

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

## Límites honestos (MVP)

Metadatos no ocultos (el sobre expone `from`/`to`) · una clave por dispositivo · handles
`@dominio` y relay/tiempo-real en fases siguientes · `created_at` auto-aseverado, orden **causal**
entre partes. Ver `SPEC-F0.md §11`.
