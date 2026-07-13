import {
  reactExtension,
  useApi,
} from "@shopify/ui-extensions-react/customer-account";
import { Button } from "@shopify/ui-extensions-react/checkout";
import { useEffect, useState } from "react";

export default reactExtension(
  "customer-account.order-status.payment-details.render-after",
  () => <PayButton />
);

function extractId(gidString) {
  const parts = gidString.split("/");
  return parts[parts.length - 1];
}

function PayButton() {
  const { order } =
    useApi<"customer-account.order-status.payment-details.render-after">();
  const orderId = order?.current?.id;
  const [orderData, setOrderData] = useState(null);

  useEffect(() => {
    async function getOrderData() {
      const orderQuery = await fetch(
        "shopify://customer-accounts/api/unstable/graphql.json",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: `
              query {
                order(id: "${orderId}") {
                  id
                  currencyCode
                  financialStatus
                }
              }
            `,
          }),
        }
      );
      const result = await orderQuery.json();
      setOrderData(result.data);
      console.log(result);
    }
    getOrderData();
  }, [orderId]);

  // Only render button if financial status is PENDING
  if (!orderData || orderData.order?.financialStatus !== "PENDING") {
    return null;
  }

  return (
    <Button
      to={`https://demo.pisol.net/sarkany-form/?order=${extractId(orderId)}`}
    >
      Pagar pedido
    </Button>
  );
}
