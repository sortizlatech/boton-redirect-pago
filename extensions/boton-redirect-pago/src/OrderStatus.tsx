import {
  reactExtension,
  Banner,
  BlockStack,
  Button,
  ClipboardItem,
  Heading,
  HeadingGroup,
  InlineLayout,
  InlineStack,
  SkeletonText,
  SkeletonTextBlock,
  Spinner,
  Text,
  TextField,
  Tooltip,
  View,
  useApi,
  useOrder,
  useShop,
} from "@shopify/ui-extensions-react/customer-account";

import { useEffect, useState } from "react";
import {
  COUNTDOWN_VISIBLE_MS,
  POLL_INTERVAL_MS,
  formatExpirationTimestamp,
  formatMoney,
  getApiBase,
  getOrCreatePayment,
  getPaymentPublic,
  isExpired,
  isPaid,
  isTerminal,
  mergePaymentUpdate,
  titleCase,
} from "./taloShared";

// URL pública de la DigitalOcean Function `pisol/payment-method-checker`.
// Debe coincidir con la de Checkout.tsx (ver backend/README.md).
const BACKEND_URL =
  "https://faas-nyc1-2ef2e6cc.doserverless.co/api/v1/web/fn-bde82698-30da-4d19-a818-e234473327e6/pisol/payment-method-checker";

export default reactExtension("customer-account.order-status.block.render", () => (
  <Extension />
));

function Extension() {
  const order = useOrder();
  const { sessionToken } = useApi();
  const orderGid = order?.id;
  // status: "loading" | "redirect" | "transfer" | "error".
  const [status, setStatus] = useState("loading");
  const [payUrl, setPayUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function decide() {
      try {
        if (!orderGid) return;
        const token = await sessionToken.get();
        const resp = await fetch(BACKEND_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ orderId: orderGid }),
        });
        if (!resp.ok) throw new Error(`backend respondio ${resp.status}`);
        const result = await resp.json();
        if (cancelled) return;

        if (result?.show && result?.mode === "redirect" && result?.payUrl) {
          setPayUrl(result.payUrl);
          setStatus("redirect");
        } else if (result?.show && result?.mode === "transfer") {
          setStatus("transfer");
        } else {
          setStatus("error");
        }
      } catch (error) {
        console.error("[pisol] order-status pay-decision error", error);
        if (!cancelled) setStatus("error");
      }
    }

    decide();
    return () => {
      cancelled = true;
    };
  }, [orderGid]);

  if (status === "loading") {
    return (
      <InlineStack spacing="base" blockAlignment="center">
        <Spinner size="small" accessibilityLabel="Cargando método de pago" />
        <Text appearance="subdued" size="small">
          Cargando método de pago…
        </Text>
      </InlineStack>
    );
  }

  // Gateway "Tarjeta Custom Manual": boton que redirige a la pasarela.
  if (status === "redirect" && payUrl) {
    return (
      <BlockStack spacing="tight">
        <Button to={payUrl}>IR A PAGAR</Button>
      </BlockStack>
    );
  }

  // Gateway "Transferencia Bancaria": UI de transferencia Talo embebida.
  if (status === "transfer") {
    return <OrderStatusTaloTransfer />;
  }

  // Falla del backend o modo no reconocido.
  return (
    <BlockStack spacing="tight">
      <Text appearance="critical" size="small">
        No es posible cargar el método de pago.
      </Text>
    </BlockStack>
  );
}

// Container de la UI de transferencia en la order-status page. A diferencia de la
// thank-you, el monto se lee de la Cost API y el order id del Order API.
function OrderStatusTaloTransfer() {
  const order = useOrder();
  const shop = useShop();
  const { cost } = useApi();
  const apiBase = getApiBase();
  const [payment, setPayment] = useState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const total = cost?.totalAmount?.current;
    if (
      shop &&
      order?.id &&
      total?.amount &&
      total?.currencyCode &&
      !payment
    ) {
      const shopIdNumbers = shop.id.split("/")[4];
      const orderIdNumbers = order.id.split("/")[4];
      // La funcion async se maneja con try/catch adentro: si se llamara sin
      // await, los errores de la promesa quedarian sin capturar y el bloque
      // se quedaria en skeleton para siempre.
      const createPayment = async () => {
        try {
          const created = await getOrCreatePayment(
            total.amount,
            total.currencyCode,
            shopIdNumbers,
            orderIdNumbers,
            apiBase
          );
          if (created?.id) {
            setPayment(created);
          } else {
            console.error(
              "[pisol] Talo no devolvio data de pago (order-status)",
              created
            );
            setError(true);
          }
        } catch (e) {
          console.error("[pisol] error creando pago en Talo (order-status)", e);
          setError(true);
        } finally {
          setLoading(false);
        }
      };
      createPayment();
    }
  }, [shop, order, cost, payment, apiBase]);

  useEffect(() => {
    if (!payment?.id) return;
    if (isTerminal(payment.payment_status)) return;

    const interval = setInterval(async () => {
      try {
        const updated = await getPaymentPublic(payment.id, apiBase);
        if (updated) {
          setPayment((previous) => mergePaymentUpdate(previous, updated));
        }
      } catch (error) {
        // Se reintenta en el próximo tick del poll.
      }
    }, POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [payment?.id, payment?.payment_status, apiBase]);

  if (error) {
    return (
      <View background="base">
        <Banner
          status="critical"
          title="No es posible cargar el método de pago."
        />
      </View>
    );
  }

  if (!payment || loading) {
    return <TransferenciasSkeleton />;
  }

  return (
    <TransferData
      paymentStatus={payment.payment_status}
      amount={payment.price?.amount}
      amountPaid={Number(payment?.transaction_fields?.total_paid?.amount)}
      alias={payment?.quotes[0].alias || payment?.quotes[0]?.address}
      titular={payment?.user_info?.full_name}
      bank={titleCase(payment?.quotes?.[0]?.network)}
      expirationTimestamp={payment.expiration_timestamp}
      loading={loading}
    />
  );
}

function TransferData({
  paymentStatus,
  alias,
  titular,
  bank,
  amount,
  amountPaid,
  expirationTimestamp,
  loading,
}) {
  if (isPaid(paymentStatus)) {
    return (
      <View background="base">
        <Banner
          status="success"
          title="Ya recibimos tu pago y estamos preparando tu pedido."
        />
      </View>
    );
  }
  if (isExpired(paymentStatus)) {
    return (
      <View background="base">
        <Banner
          status="critical"
          title="El plazo para el pago expiró. Tu orden será cancelada."
        />
      </View>
    );
  }
  return (
    <View background="base">
      <BlockStack>
        <Heading>Datos de transferencia exclusivos para esta compra</Heading>
        <PaymentStatusBlock
          paymentStatus={paymentStatus}
          amount={amount}
          amountPaid={amountPaid}
        />
        <PaymentDetails
          alias={alias}
          titular={titular}
          bank={bank}
          amount={amount}
          loading={loading}
          expirationTimestamp={expirationTimestamp}
        />
      </BlockStack>
    </View>
  );
}

const PaymentStatusBlock = ({ paymentStatus, amount, amountPaid }) => {
  if (!paymentStatus) return <></>;
  if (paymentStatus === "PENDING") {
    return (
      <Banner
        status="warning"
        title="Tu orden permanecera pendiente hasta que recibamos tu pago."
      />
    );
  } else if (paymentStatus === "UNDERPAID") {
    const paid = Math.max(0, Math.min(Number(amountPaid) || 0, amount || 0));
    const missing = Math.max(0, (amount || 0) - paid);
    return (
      <Banner status="info" title="Pago incompleto">
        <Text>
          El pago recibido es inferior al de la orden de compra. Enviá el
          restante para completar la compra.
        </Text>
        <Text emphasis="bold">
          Transferiste {formatMoney(paid)} de {formatMoney(amount)} — Falta{" "}
          {formatMoney(missing)}
        </Text>
      </Banner>
    );
  }
  return <></>;
};

const PaymentDetails = ({
  alias,
  titular,
  bank,
  amount,
  loading,
  expirationTimestamp,
}) => {
  const formattedExpiration = formatExpirationTimestamp(expirationTimestamp);

  return (
    <BlockStack border="base" borderRadius="base" padding="base">
      <HeadingGroup>
        <InlineLayout columns={["fill", "auto"]} blockAlignment="center">
          {formattedExpiration ? (
            <Heading>Realiza el pago hasta el dia {formattedExpiration}</Heading>
          ) : (
            <Heading>Realizá el pago para completar tu compra</Heading>
          )}
          <ExpirationCountdown expirationTimestamp={expirationTimestamp} />
        </InlineLayout>
        <Text>
          Después de este plazo, los datos bancarios expirarán y tu pedido será
          cancelado. El estado de la orden se actualizara una vez recibido el
          pago. ¡No hace falta enviar comprobante!
        </Text>
        {titular && bank ? (
          <BlockStack spacing="extraTight">
            <Text>Titular: {titular}</Text>
            <Text>Banco: {bank}</Text>
          </BlockStack>
        ) : null}

        <InlineLayout
          columns={["fill", "auto"]}
          spacing="base"
          blockAlignment="end"
        >
          <TextField
            id="alias-text-talo-os"
            label="Alias exclusivo para esta compra"
            value={alias}
            readonly
          />
          <ClipboardItem id="talo-alias-clipboard-os" text={alias} />
          <Button
            kind="secondary"
            accessibilityLabel="Copiar alias"
            activateTarget="talo-alias-clipboard-os"
            loading={loading}
            overlay={<Tooltip>¡Copiado!</Tooltip>}
          >
            Copiar
          </Button>
        </InlineLayout>

        <InlineLayout
          columns={["fill", "auto"]}
          spacing="base"
          blockAlignment="end"
        >
          <TextField
            label="Monto exacto"
            type="number"
            prefix="$"
            value={amount}
            readonly
          />
          <ClipboardItem id="talo-amount-clipboard-os" text={String(amount)} />
          <Button
            kind="secondary"
            accessibilityLabel="Copiar monto"
            activateTarget="talo-amount-clipboard-os"
            loading={loading}
            overlay={<Tooltip>¡Copiado!</Tooltip>}
          >
            Copiar
          </Button>
        </InlineLayout>
      </HeadingGroup>
    </BlockStack>
  );
};

function ExpirationCountdown({ expirationTimestamp }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  if (!expirationTimestamp) return null;

  const remainingMs = new Date(expirationTimestamp).getTime() - now;
  if (
    Number.isNaN(remainingMs) ||
    remainingMs <= 0 ||
    remainingMs > COUNTDOWN_VISIBLE_MS
  )
    return null;

  const totalSeconds = Math.floor(remainingMs / 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return (
    <Text emphasis="bold" appearance="critical">
      {pad(hours)}:{pad(minutes)}:{pad(seconds)}
    </Text>
  );
}

const TransferenciasSkeleton = () => {
  return (
    <BlockStack border="base" padding="base">
      <Heading>Datos de transferencia exclusivos para esta compra</Heading>
      <SkeletonTextBlock lines={1} />
      <BlockStack border="base" padding="base">
        <HeadingGroup>
          <InlineStack>
            <Heading>Alias:</Heading>
            <SkeletonText size="large" />
          </InlineStack>
          <InlineStack>
            <Heading>Monto</Heading>
            <SkeletonText size="large" />
          </InlineStack>
        </HeadingGroup>
      </BlockStack>
    </BlockStack>
  );
};
