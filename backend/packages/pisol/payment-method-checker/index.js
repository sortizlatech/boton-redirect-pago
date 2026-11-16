const crypto = require("crypto");

function base64urlToBuffer(input) {
  let str = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4;
  if (pad) str += "=".repeat(4 - pad);
  return Buffer.from(str, "base64");
}

// Verifica el session token de Shopify (JWT HS256 firmado con el client secret de la app).
function verifySessionToken(token, clientSecret, clientId) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [headerB64, payloadB64, sigB64] = parts;

  const expected = crypto
    .createHmac("sha256", clientSecret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const actual = base64urlToBuffer(sigB64);

  if (
    expected.length !== actual.length ||
    !crypto.timingSafeEqual(expected, actual)
  ) {
    throw new Error("invalid signature");
  }

  const payload = JSON.parse(base64urlToBuffer(payloadB64).toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) throw new Error("token expired");
  if (payload.nbf && now < payload.nbf) throw new Error("token not yet valid");
  if (clientId && payload.aud !== clientId) throw new Error("audience mismatch");

  return payload;
}

function shopFromDest(dest) {
  if (!dest) return null;
  try {
    // El dest del session token puede venir como URL ("https://shop.myshopify.com")
    // o como dominio pelado ("shop.myshopify.com"). Normalizamos ambos.
    const withProto = dest.includes("://") ? dest : `https://${dest}`;
    return new URL(withProto).host;
  } catch (e) {
    return null;
  }
}

// --- Reintento de la consulta a la Admin API -----------------------------------
// En la thank-you la extension puede consultar antes de que Shopify termine de crear
// el pedido: la Admin API devuelve order = null (o el pedido sin transacciones todavia).
// En las tiendas listadas en RETRY_SHOPS se reintenta en esos casos.

// Tiempo maximo total de reintentos (desde que arranca la funcion). Debe quedar bien
// por debajo del timeout de la funcion en project.yml.
const RETRY_BUDGET_MS = 12000;
// Tiempo maximo de cada consulta a la Admin API.
const REQUEST_TIMEOUT_MS = 4000;
// Espera antes de cada reintento (el ultimo valor se repite).
const RETRY_DELAYS_MS = [800, 1200, 2000, 3000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// +-20% para que pedidos simultaneos no reintenten todos al mismo tiempo.
const withJitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

function gatewayNamesOf(order) {
  const gatewayNames = order.paymentGatewayNames || [];
  const formatted = (order.transactions || []).map((t) => t.formattedGateway);
  return [...gatewayNames, ...formatted].filter(Boolean);
}

function isThrottled(data) {
  const errors = data && data.errors;
  return (
    Array.isArray(errors) &&
    errors.some((e) => e && e.extensions && e.extensions.code === "THROTTLED")
  );
}

// Hace una consulta y clasifica el resultado:
// - transportError: fallo de red, timeout o respuesta no JSON (la version anterior
//   respondia 502 en estos casos).
// - retriable: vale la pena volver a consultar (pedido aun no listo, throttling,
//   error temporal de Shopify). Errores de credenciales/permisos NO se reintentan.
async function fetchOrder(url, adminToken, body, withTimeout) {
  let resp;
  let data;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": adminToken,
      },
      body,
      // Sin reintento se mantiene el comportamiento anterior (sin timeout propio).
      signal: withTimeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
    });
    data = await resp.json();
  } catch (e) {
    const status = resp ? resp.status : 0;
    const errName = (e && e.name) || "error";
    const timedOut = errName === "TimeoutError" || errName === "AbortError";
    const reason =
      resp && !timedOut ? `http_${status}_no_json` : `network_${errName}`;
    // Sin respuesta, timeout o 429/5xx: temporal. Otro status sin JSON: no se reintenta.
    const retriable = !resp || timedOut || status === 429 || status >= 500;
    return { transportError: true, retriable, reason };
  }

  const status = resp.status;
  const order = data && data.data && data.data.order;

  if (status === 429 || status >= 500 || isThrottled(data)) {
    return { data, retriable: true, reason: isThrottled(data) ? "throttled" : `http_${status}` };
  }
  if (status >= 400) {
    // 401/403/404 de la Admin API: token invalido, sin permisos, tienda inexistente.
    return { data, retriable: false, reason: `http_${status}` };
  }
  if (!order) {
    // Errores GraphQL (ej. ACCESS_DENIED) no se arreglan reintentando.
    if (data && data.errors) return { data, retriable: false, reason: "graphql_error" };
    return { data, retriable: true, reason: "order_not_found" };
  }
  if (
    order.displayFinancialStatus === "PENDING" &&
    gatewayNamesOf(order).length === 0
  ) {
    // Pedido creado pero sin transacciones todavia.
    return { data, retriable: true, reason: "no_gateway_yet" };
  }
  return { data, retriable: false, reason: "ok" };
}

async function main(args) {
  const startedAt = Date.now();
  const method = (args.__ow_method || "post").toUpperCase();
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders, body: "" };
  }

  const headers = args.__ow_headers || {};
  const auth = headers.authorization || headers.Authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const orderId = args.orderId; // gid://shopify/Order/123

  const CLIENT_ID = process.env.APP_CLIENT_ID;
  const CLIENT_SECRET = process.env.APP_CLIENT_SECRET;
  // Gateway que dispara el boton de redirect (comportamiento original).
  const TARGET_GATEWAY = process.env.TARGET_GATEWAY || "Tarjeta de crédito/débito";
  // Gateway que dispara la UI de transferencia embebida (Talo).
  const TRANSFER_GATEWAY = process.env.TRANSFER_GATEWAY || "Transferencia Bancaria";
  const PAY_URL_BASE = process.env.PAY_URL_BASE || "";
  const API_VERSION = process.env.ADMIN_API_VERSION || "2025-07";
  // RETRY_SHOPS: dominios separados por "," o ";" donde se activa el reintento.
  // Vacio = sin reintento en ninguna tienda (comportamiento anterior).
  const RETRY_SHOPS = new Set(
    (process.env.RETRY_SHOPS || "")
      .split(/[;,]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  // SHOP_TOKENS: "shop1.myshopify.com=shpat_xxx;shop2.myshopify.com=shpat_yyy"
  const shopTokens = {};
  for (const pair of (process.env.SHOP_TOKENS || "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const domain = pair.slice(0, idx).trim();
    const tok = pair.slice(idx + 1).trim();
    if (domain && tok) shopTokens[domain] = tok;
  }

  if (!token || !orderId) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ error: "missing token or orderId" }),
    };
  }

  let payload;
  try {
    payload = verifySessionToken(token, CLIENT_SECRET, CLIENT_ID);
  } catch (e) {
    return {
      statusCode: 401,
      headers: corsHeaders,
      body: JSON.stringify({ error: "unauthorized: " + e.message }),
    };
  }

  const shop = shopFromDest(payload.dest);
  const adminToken = shop && shopTokens[shop];
  if (!shop || !adminToken) {
    return {
      statusCode: 403,
      headers: corsHeaders,
      body: JSON.stringify({ error: "no admin token configured for shop", shop }),
    };
  }

  // El orderId de la thank-you page llega como gid://shopify/OrderIdentity/<id>,
  // pero la Admin API espera gid://shopify/Order/<id>. Normalizamos al tipo Order.
  const numericId = String(orderId).split("/").pop();
  const adminOrderGid = `gid://shopify/Order/${numericId}`;

  const query = `query GetOrderGateway($id: ID!) {
    order(id: $id) {
      id
      displayFinancialStatus
      paymentGatewayNames
      transactions { id formattedGateway manualPaymentGateway }
    }
  }`;

  const retryEnabled = RETRY_SHOPS.has(shop.toLowerCase());
  const adminUrl = `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  const requestBody = JSON.stringify({ query, variables: { id: adminOrderGid } });

  // Sin reintento: una sola consulta y mismo comportamiento que la version anterior.
  // Con reintento (tiendas en RETRY_SHOPS): si el pedido todavia no esta listo en la
  // Admin API (recien creado en la thank-you), se vuelve a consultar hasta RETRY_BUDGET_MS.
  const deadline = startedAt + RETRY_BUDGET_MS;
  let result;
  let attempts = 0;
  for (;;) {
    attempts++;
    result = await fetchOrder(adminUrl, adminToken, requestBody, retryEnabled);
    if (!retryEnabled || !result.retriable) break;

    const delay = withJitter(
      RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)]
    );
    // No se arranca un reintento despues del deadline. Peor caso total:
    // RETRY_BUDGET_MS + REQUEST_TIMEOUT_MS (~16s), por debajo del timeout de 30s.
    if (Date.now() + delay > deadline) break;
    await sleep(delay);
  }

  // Campos de diagnostico solo en tiendas con reintento: la respuesta de las demas
  // tiendas queda identica a la version anterior. La extension los ignora.
  const diag = retryEnabled
    ? { attempts, reason: result.reason, elapsedMs: Date.now() - startedAt }
    : {};

  if (result.transportError) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: "admin api request failed", ...diag }),
    };
  }

  const data = result.data;
  const order = data && data.data && data.data.order;
  if (!order) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "order not found",
        details: data && data.errors,
        ...diag,
      }),
    };
  }

  const allNames = gatewayNamesOf(order);

  const isPending = order.displayFinancialStatus === "PENDING";

  // Segun el gateway, elegimos el modo de UI que la extension debe renderizar:
  // - "redirect": boton que redirige a PAY_URL_BASE (comportamiento original).
  // - "transfer": UI de transferencia embebida (Talo).
  let mode = null;
  if (allNames.some((n) => n === TARGET_GATEWAY)) {
    mode = "redirect";
  } else if (allNames.some((n) => n === TRANSFER_GATEWAY)) {
    mode = "transfer";
  }

  const show = !!mode && isPending;

  const payUrl =
    show && mode === "redirect" && PAY_URL_BASE
      ? `${PAY_URL_BASE}${PAY_URL_BASE.includes("?") ? "&" : "?"}order=${numericId}`
      : null;

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ show, mode, payUrl, gatewayNames: allNames, ...diag }),
  };
}

exports.main = main;
