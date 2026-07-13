import {
  reactExtension,
  Button,
  useApi,
  BlockStack,
} from "@shopify/ui-extensions-react/checkout";
import { useEffect, useState } from "react";

// URL pública de la DigitalOcean Function `pisol/pay-decision`.
// Reemplazar tras el deploy (ver backend/README.md).
const BACKEND_URL =
  "https://faas-nyc1-2ef2e6cc.doserverless.co/api/v1/web/fn-bde82698-30da-4d19-a818-e234473327e6/pisol/payment-method-checker";

export default reactExtension("purchase.thank-you.block.render", () => (
  <Extension />
));

function Extension() {
  const api = useApi("purchase.thank-you.block.render");
  const orderGid = api?.orderConfirmation?.current?.order?.id;
  const [payUrl, setPayUrl] = useState(null);
  const [loading, setLoading] = useState(true);

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
        const result = await resp.json();
        if (!cancelled && result?.show && result?.payUrl) {
          setPayUrl(result.payUrl);
        }
      } catch (error) {
        console.error("[pisol] pay-decision error", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    decide();
    return () => {
      cancelled = true;
    };
  }, [orderGid]);

  if (loading || !payUrl) return null;

  return (
    <BlockStack spacing="tight">
      <Button to={payUrl}>IR A PAGAR</Button>
    </BlockStack>
  );
}
