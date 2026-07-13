# Handoff / Contexto del proyecto

Este documento resume la tarea para retomar el trabajo en esta carpeta
(`boton-redirect-pago`, copia aislada del repo de producción `pisol-pay-now-button`).

## Objetivo

Mostrar un botón **"PAGAR PEDIDO"** en la **thank-you page** de Shopify **solo cuando
el pedido se pagó con un método de pago manual específico llamado
`Tarjeta Custom Manual`**. Debe funcionar en **varias tiendas** (la app se instala en
múltiples stores), todas Shopify **Plus**.

## Qué es la app

App de Shopify **extension-only** (sin panel embebido). Contiene 1 extensión:

- `extensions/boton-redirect-pago` — checkout UI extension, target `purchase.thank-you.block.render`
  (thank-you page). **Es la que estamos trabajando.**

El botón redirige a una pasarela externa para pagos manuales/pendientes.

> Nota: antes existía una segunda extensión `extensions/order-status-pay-button`
> (customer-account, target `customer-account.order-status.payment-details.render-after`,
> mostraba el botón si `financialStatus === "PENDING"`). Fue eliminada de este proyecto.

## El problema técnico (por qué hace falta backend)

Para distinguir "Tarjeta Custom Manual" de otros métodos manuales:

- En el cliente, `selectedPaymentOptions` (Payments API, disponible en thank-you) solo
  da `type` + `handle`. **No da el nombre.**
- Todos los métodos manuales comparten `type: "manualPayment"` → no distingue.
- El `handle` (`custom-manual-payment-<hash>`) **es específico de cada tienda** (el hash
  sale del ID interno del método), así que **no es portable entre stores** ni estable
  para hardcodear. Se verificó que el hash NO es un MD5 del nombre.
- El Customer Account API tampoco expone el nombre del gateway (se validó contra el
  schema: `OrderTransaction` no tiene `gateway`/`formattedGateway`).
- **El nombre real (`formattedGateway` = "Tarjeta Custom Manual") solo existe en la
  Admin API**, que es server-side → por eso el backend.

## Arquitectura de la solución

```
Extensión thank-you  --(orderId GID + session token)-->  Backend (DO Function)
                                                             |
                                        verifica session token (JWT HS256 con client secret)
                                        saca el shop del claim "dest"
                                                             |
                                        Admin API del shop (scope read_orders)
                                        lee paymentGatewayNames / formattedGateway
                                                             |
Extensión muestra/oculta  <--({ show, payUrl })-------------+
   el botón segun respuesta
```

Match por **nombre** (estable e igual en todas las tiendas), no por handle.

Query Admin usada (validada contra schema, versión 2025-07):

```graphql
query GetOrderGateway($id: ID!) {
  order(id: $id) {
    id
    displayFinancialStatus
    paymentGatewayNames
    transactions { id formattedGateway manualPaymentGateway }
  }
}
```

## Decisiones tomadas

- **Autenticación del backend a la Admin API:** token manual por tienda (custom app
  token con `read_orders`), NO OAuth. Motivo: son pocas tiendas propias/controladas.
- **Hosting del backend:** DigitalOcean Functions.
- **Seguridad:** la extensión manda un session token; el backend lo verifica (firma +
  exp + aud) y usa el shop del claim `dest`. Nunca confía solo en el `orderId`.

## Estado actual

Hecho:
- `backend/` completo (DO Function `pisol/pay-decision`):
  - `packages/pisol/pay-decision/index.js` — verifica token, consulta Admin API, decide.
  - `project.yml`, `.env.example`, `.gitignore`, `README.md`.
  - `SHOP_TOKENS` en formato `dominio=token;dominio=token` (a prueba de interpolación YAML).
- Extensión `pisol-pay-now`:
  - `shopify.extension.toml` → `network_access = true`.
  - `src/Checkout.tsx` → pide session token, llama al backend, muestra botón según `show`.
  - `tsconfig.json` → agregado `lib: ["ES2015","DOM"]`.
- `shopify.app.toml` de esta copia: nombre/handle cambiados a "Boton Redirect Pago" /
  `boton-redirect-pago` y **sin client_id** (para linkear una app nueva y aislar prod).

Pendiente:
1. Linkear esta copia a una app NUEVA: `shopify app config link` (o `shopify app dev --reset`)
   → elegir "Create a new app" ("Boton Redirect Pago"). Verificar `client_id` distinto
   al de prod (`2652412aaf97b8cf9b778c31859fea5b`) con `shopify app info`.
2. `npm install` en la raíz (una vez, por las dudas). El backend NO necesita npm install.
3. Crear token Admin `read_orders` en cada dev/store (Settings → Apps → Develop apps).
4. Completar `backend/.env` (APP_CLIENT_ID/SECRET de la app NUEVA, TARGET_GATEWAY,
   PAY_URL_BASE, SHOP_TOKENS).
5. Deploy DO: `doctl serverless deploy .` desde `backend/` y obtener la URL con
   `doctl serverless functions get pisol/pay-decision --url`.
6. Pegar la URL en `BACKEND_URL` dentro de `extensions/pisol-pay-now/src/Checkout.tsx`
   (hoy tiene un placeholder `https://REEMPLAZAR-con-tu-funcion-do`).
7. Probar con `shopify app dev`: pedido con "Tarjeta Custom Manual" → botón aparece;
   con otro método → no aparece.

## Gotchas importantes

- **Aislamiento de producción:** copiar la carpeta NO aísla si mantiene el mismo
  `client_id`. La copia ya quedó sin client_id → hay que linkear app nueva (paso 1).
  Mientras tanto, `deploy --no-release` y `app dev` no afectan prod.
- **client_id y backend:** el session token trae `aud = client_id`. Si la copia usa una
  app nueva, `backend/.env` debe tener el `APP_CLIENT_ID`/`APP_CLIENT_SECRET` de ESA app,
  o el backend rechaza los tokens (audience mismatch).
- **network_access en producción:** para checkout UI extensions, usar red externa en vivo
  requiere solicitar aprobación de network access a Shopify (en dev funciona directo).
- **Migración de uid:** las extensiones ya tienen `uid` en sus `.toml`. Si el CLI pide
  mapear uids, correr `shopify app deploy` interactivo (sin `--force`); usar `--no-release`
  para no publicar.
- **Repo:** esta carpeta trae su propio `.git` y `node_modules` (autocontenida).

## Referencia rápida de archivos

- Extensión a modificar: `extensions/pisol-pay-now/src/Checkout.tsx`
- Backend: `backend/packages/pisol/pay-decision/index.js`
- Deploy backend: `backend/README.md`
