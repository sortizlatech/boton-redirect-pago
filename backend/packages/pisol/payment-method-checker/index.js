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
  try {
    return new URL(dest).host;
  } catch (e) {
    return null;
  }
}

async function main(args) {
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
  const TARGET_GATEWAY = process.env.TARGET_GATEWAY || "Tarjeta Custom Manual";
  const PAY_URL_BASE = process.env.PAY_URL_BASE || "";
  const API_VERSION = process.env.ADMIN_API_VERSION || "2025-07";

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

  const query = `query GetOrderGateway($id: ID!) {
    order(id: $id) {
      id
      displayFinancialStatus
      paymentGatewayNames
      transactions { id formattedGateway manualPaymentGateway }
    }
  }`;

  let data;
  try {
    const resp = await fetch(
      `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": adminToken,
        },
        body: JSON.stringify({ query, variables: { id: orderId } }),
      }
    );
    data = await resp.json();
  } catch (e) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ error: "admin api request failed" }),
    };
  }

  const order = data && data.data && data.data.order;
  if (!order) {
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: "order not found", details: data && data.errors }),
    };
  }

  const gatewayNames = order.paymentGatewayNames || [];
  const formatted = (order.transactions || []).map((t) => t.formattedGateway);
  const allNames = [...gatewayNames, ...formatted].filter(Boolean);

  const matches = allNames.some((n) => n === TARGET_GATEWAY);
  const isPending = order.displayFinancialStatus === "PENDING";
  const show = matches && isPending;

  const numericId = String(orderId).split("/").pop();
  const payUrl =
    show && PAY_URL_BASE
      ? `${PAY_URL_BASE}${PAY_URL_BASE.includes("?") ? "&" : "?"}order=${numericId}`
      : null;

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ show, payUrl, gatewayNames: allNames }),
  };
}

exports.main = main;
