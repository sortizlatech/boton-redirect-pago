import {
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
  Text,
  TextField,
  Tooltip,
  useApi,
  useShop,
  useTotalAmount,
  View,
} from "@shopify/ui-extensions-react/checkout";

import { useEffect, useState } from "react";
import {
  COUNTDOWN_VISIBLE_MS,
  POLL_INTERVAL_MS,
  examplePayment,
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

// UI de transferencia Talo para la thank-you page (checkout). Se renderiza cuando el
// backend decide mode === "transfer" (gateway === TRANSFER_GATEWAY). Crea/recupera el
// pago en Talo y hace polling del estado hasta un estado terminal.
export function TaloTransfer() {
  const shop = useShop();
  const { amount, currencyCode } = useTotalAmount();
  const apiDetails = useApi();
  const apiBase = getApiBase();
  const [payment, setPayment] = useState();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (
      shop &&
      apiDetails.orderConfirmation?.current?.order?.id &&
      amount &&
      currencyCode &&
      !payment
    ) {
      const shopIdNumbers = shop.id.split("/")[4];
      // El order id viene como gid://shopify/OrderIdentity/5787230732369
      const orderIdNumbers =
        apiDetails.orderConfirmation?.current?.order?.id.split("/")[4];
      if (apiDetails.orderConfirmation?.current?.number === "ABC123EXAMPLE") {
        setPayment(examplePayment);
        setLoading(false);
      } else {
        // La funcion async se maneja con try/catch adentro: si se llamara sin
        // await, los errores de la promesa quedarian sin capturar y el bloque
        // se quedaria en skeleton para siempre.
        const createPayment = async () => {
          try {
            const created = await getOrCreatePayment(
              amount,
              currencyCode,
              shopIdNumbers,
              orderIdNumbers,
              apiBase
            );
            if (created?.id) {
              setPayment(created);
            } else {
              console.error(
                "[pisol] Talo no devolvio data de pago (thank-you)",
                created
              );
              setError(true);
            }
          } catch (e) {
            console.error("[pisol] error creando pago en Talo (thank-you)", e);
            setError(true);
          } finally {
            setLoading(false);
          }
        };
        createPayment();
      }
    }
  }, [shop, apiDetails, amount, currencyCode, payment, apiBase]);

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
    // status="warning" (no "info") para que el icono se vea en amarillo.
    // PENDING y UNDERPAID nunca se muestran juntos, así que comparten color
    // sin ambigüedad visual.
    return (
      <Banner
        status="warning"
        title="Tu orden permanecera pendiente hasta que recibamos tu pago."
      />
    );
  } else if (paymentStatus === "UNDERPAID") {
    // status="info" (no "warning"/"critical") para diferenciarse visualmente
    // del banner de PENDING sin usar rojo (genera alarma innecesaria).
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
            id="alias-text-talo"
            label="Alias exclusivo para esta compra"
            value={alias}
            readonly
          />
          <ClipboardItem id="talo-alias-clipboard" text={alias} />
          <Button
            kind="secondary"
            accessibilityLabel="Copiar alias"
            activateTarget="talo-alias-clipboard"
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
          <ClipboardItem id="talo-amount-clipboard" text={String(amount)} />
          <Button
            kind="secondary"
            accessibilityLabel="Copiar monto"
            activateTarget="talo-amount-clipboard"
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

// Countdown a la derecha del heading. Solo se activa si faltan menos de 24hs
// para no competir con el texto fijo durante el resto del plazo.
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
