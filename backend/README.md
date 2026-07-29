# Backend `pay-decision` (DigitalOcean Functions)

Decide si el botón "PAGAR PEDIDO" debe mostrarse en la thank-you page, según el
método de pago con el que se creó la orden.

Flujo:

1. La extensión de checkout manda `orderId` (GID) + un **session token** de Shopify.
2. Esta función verifica el session token (JWT HS256 firmado con el client secret) y
   obtiene el dominio de la tienda del claim `dest`.
3. Con el **Admin API access token** de esa tienda consulta el pedido y lee
   `paymentGatewayNames` / `transactions.formattedGateway`.
4. Devuelve `{ show, mode, payUrl }` según el gateway del pedido (estando `PENDING`):
   - `mode: "redirect"` + `payUrl` si coincide con `TARGET_GATEWAY` (botón que redirige).
   - `mode: "transfer"` si coincide con `TRANSFER_GATEWAY` (UI de transferencia Talo embebida).
   - `show: false` si no coincide con ninguno o el pedido no está `PENDING`.

## 1. Crear el Admin API token en cada tienda

Por cada tienda donde corra la app:

1. Admin de la tienda → **Settings → Apps and sales channels → Develop apps**.
2. **Create an app** (ej. "pisol-pay-backend").
3. **Configure Admin API scopes** → activá **`read_orders`**.
4. **Install app** → en **API credentials** copiá el **Admin API access token** (`shpat_...`).
5. Guardá el par `dominio → token` para el env `SHOP_TOKENS`.

> Este token es independiente de los scopes OAuth de la app (no hace falta cambiar
> `shopify.app.toml`).

## 2. Configurar variables de entorno

Copiá `.env.example` a `.env` y completá:

- `APP_CLIENT_SECRET`: client secret de la app (Dev Dashboard → la app → API credentials).
- `SHOP_TOKENS`: pares `dominio=token` separados por `;` (un token por tienda),
  ej. `shop.myshopify.com=shpca_...;otra.myshopify.com=shpca_...`.
- `TARGET_GATEWAY`: método manual que muestra el botón de redirect (ej. `Tarjeta de crédito/débito`).
- `TRANSFER_GATEWAY`: método manual que muestra la UI de transferencia Talo (ej. `Transferencia Bancaria`).
- `PAY_URL_BASE`: URL de la pasarela para el modo `redirect`.

```bash
cp .env.example .env
# editar .env
```

## 3. Deploy con doctl

Requisitos: [doctl](https://docs.digitalocean.com/reference/doctl/how-to/install/) instalado
y una namespace de Functions creada.

```bash
# autenticación (una vez)
doctl auth init
doctl serverless install
doctl serverless connect

# deploy (desde la carpeta backend/, toma las vars de .env)
doctl serverless deploy . --env .env

# obtener la URL pública de la función
doctl serverless functions get pisol/pay-decision --url
```

Esa URL (algo como
`https://faas-nyc1-XXXX.doserverless.co/api/v1/web/fn-.../pisol/pay-decision`)
es la que hay que poner en `BACKEND_URL` dentro de
`extensions/pisol-pay-now/src/Checkout.tsx`.

## 4. Probar

```bash
# preflight CORS
curl -i -X OPTIONS "<URL>"

# sin token válido debe dar 401
curl -i -X POST "<URL>" -H "Content-Type: application/json" \
  -d '{"orderId":"gid://shopify/Order/123"}'
```

En un pedido real, la extensión manda el session token válido y la función
responde `{ "show": true, "mode": "redirect", "payUrl": "..." }` o
`{ "show": true, "mode": "transfer" }` según el gateway del pedido (estando pendiente).

## Notas

- Node 18 (runtime `nodejs:18`): `fetch` y `crypto` son nativos, sin dependencias.
- Seguridad: la función nunca confía solo en el `orderId`; valida el session token
  y usa el shop del claim `dest`, así no se pueden pedir órdenes de otra tienda.
