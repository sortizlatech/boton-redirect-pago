import {
  reactExtension,
  Button,
  useApi,
  BlockStack,
  InlineStack,
  Spinner,
  Text,
} from "@shopify/ui-extensions-react/checkout";
import { useEffect, useState } from "react";
import { TaloTransfer } from "./TaloTransfer";

// URL pública de la DigitalOcean Function `pisol/payment-method-checker`.
// Reemplazar tras el deploy (ver backend/README.md).
const BACKEND_URL =
  "https://faas-nyc1-2ef2e6cc.doserverless.co/api/v1/web/fn-bde82698-30da-4d19-a818-e234473327e6/pisol/payment-method-checker";

export default reactExtension("purchase.thank-you.block.render", () => (
  <Extension />
));

function Extension() {
  const api = useApi("purchase.thank-you.block.render");
  const orderGid = api?.orderConfirmation?.current?.order?.id;
  // status: "loading" | "redirect" | "transfer" | "error".
  const [status, setStatus] = useState("loading");
  const [payUrl, setPayUrl] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function decide() {
      try {
        if (!orderGid) return;
        const token = await api.sessionToken.get();
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
        console.error("[pisol] pay-decision error", error);
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
    return <TaloTransfer />;
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
