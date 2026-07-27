// Lógica pura de la integración Talo (sin dependencias de React ni de Shopify),
// compartida entre la thank-you page (checkout) y la order-status (customer-account).

export const TERMINAL_STATUSES = ["SUCCESS", "OVERPAID", "EXPIRED"];
export const isTerminal = (s) => TERMINAL_STATUSES.includes(s);
export const isPaid = (s) => s === "SUCCESS" || s === "OVERPAID";
export const isExpired = (s) => s === "EXPIRED";

export const POLL_INTERVAL_MS = 10000;
// Ventana en la que se muestra el countdown en vivo (ver ExpirationCountdown).
export const COUNTDOWN_VISIBLE_MS = 24 * 60 * 60 * 1000;


export const getApiBase = () => "https://sandbox-api.talo.com.ar/payments/"; // sandbox (test)
// export const getApiBase = () => "https://api.talo.com.ar/payments/"; // produccion

export const titleCase = (value) =>
  value ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase() : undefined;

// Los updates de poll no siempre traen expiration_timestamp de vuelta; si
// falta, se mantiene el último valor conocido en vez de perderlo.
export const mergePaymentUpdate = (previous, updated) => ({
  ...updated,
  expiration_timestamp:
    updated?.expiration_timestamp ?? previous?.expiration_timestamp,
});

export function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0.00";
  return `$${number.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatExpirationTimestamp(expirationTimestamp) {
  const date = new Date(expirationTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
  return `${day}/${month} a las ${time} hs`;
}

export const getOrCreatePayment = async (
  amount,
  currency,
  storeId,
  orderId,
  apiBase = getApiBase()
) => {
  const api_url = apiBase;
  // app_id especifico de la tienda/entorno en Talo. Este valor es el del sandbox
  // de la tienda de test (coincide con el request que Talo confirmo que funciona).
  // Para produccion, Talo asigna otro app_id (cambiar junto con getApiBase).
  const app_handle = "tiendatestsarkany_talo_cvus";

  const body = {
    price: {
      amount: amount,
      currency: currency,
    },
    shopify: {
      order_id: orderId,
      store_id: storeId,
      app_id: app_handle,
    },
    motive: "shopify",
    webhook_url: `${api_url}shopify/${storeId}/${orderId}?app_id=${app_handle}`,
    external_id: `${orderId}`,
    payment_options: ["transfer"],
  };

  const response = await fetch(api_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const jsonRes = await response.json();
  return jsonRes.data;
};

export const getPaymentPublic = async (paymentId, apiBase = getApiBase()) => {
  const response = await fetch(`${apiBase}${paymentId}/public`, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  const jsonRes = await response.json();
  if (jsonRes.code > 300) return undefined;
  return jsonRes.data;
};

export const examplePayment = {
  payment_status: "UNDERPAID",
  price: {
    amount: 123456,
    currency: "ARS",
  },
  quotes: [
    {
      alias: "example.id.talo",
      address: "090192381341414124",
      amount: 123456,
      network: "POLLUX",
    },
  ],
  user_info: {
    full_name: "Talo Pagos",
  },
  expiration_timestamp: "2024-11-05T00:39:38.278Z",
  id: "SH-89252495638-6121122922774",
  transaction_fields: {
    amount: "2000",
    amountReadable: "2000",
    commission_amount: "10",
    credited_amount: "1990",
    currency: "ARS",
    network: "POLLUX",
    total_paid: { amount: "2000", currency: "ARS" },
  },
};
