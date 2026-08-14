import {
  reactExtension,
  useSelectedPaymentOptions,
  useAvailablePaymentOptions,
  Banner,
  Text,
} from "@shopify/ui-extensions-react/checkout";
import { useEffect } from "react";

const TARGET = "purchase.checkout.payment-method-list.render-after";

export default reactExtension(TARGET, () => <Extension />);

// Texto para la opcion "Tarjeta de crédito/débito" (redirect a la pasarela).
const MESSAGE_CARD =
  "Al continuar, te redirigiremos a una página segura para completar el pago. Si no finalizás el proceso, el pedido se cancelará automáticamente.";

// Texto para la opcion "Transferencia Bancaria" (datos de transferencia en la thank-you).
const MESSAGE_TRANSFER =
  "Al continuar, vas a encontrar el alias y los datos para transferir. Tendrás 1 hora para realizar el pago; después, la orden se cancelará automáticamente.";

// La API de checkout NO expone el nombre visible del metodo de pago, solo `handle` y `type`.
// Como "Tarjeta de crédito/débito" y "Transferencia Bancaria" son ambos pagos manuales
// (type "manualPayment"), resolvemos el texto por handle exacto (HANDLE_TO_MESSAGE).
// Como red de seguridad, si el handle no coincide, caemos al ORDEN entre los pagos
// manuales (asi gift-card o wallets no corren los indices):
//   manual #0 -> Tarjeta de crédito/débito
//   manual #1 -> Transferencia Bancaria
//
// Los handles son por tienda. Para leer los de otra tienda, poné DEBUG = true y mirá la
// CONSOLA del navegador durante un checkout (no se muestra nada en pantalla).
// Handles reales de sofia-sarkany.myshopify.com (produccion).
const HANDLE_TO_MESSAGE: Record<string, string> = {
  "custom-manual-payment-98783ba3c12b21c3038dc01e82583d94": MESSAGE_CARD,
  "custom-manual-payment-bfc2377bcc30f763376f7ef7c6e53fd7": MESSAGE_TRANSFER,
};

// Poné true para loguear en la consola del navegador el handle y el type de cada opcion
// de pago. No cambia lo que ve el comprador; solo escribe en consola.
const DEBUG = false;

function Extension() {
  const available = useAvailablePaymentOptions();
  const selected = useSelectedPaymentOptions();

  useEffect(() => {
    if (!DEBUG) return;
    console.log(
      "[info-metodo-pago] available:",
      available.map((o) => ({ handle: o.handle, type: o.type }))
    );
    console.log(
      "[info-metodo-pago] selected:",
      selected.map((o) => ({ handle: o.handle, type: o.type }))
    );
  }, [available, selected]);

  // Si hay varios metodos seleccionados (ej. gift-card + un pago manual),
  // priorizamos el pago manual para elegir el texto.
  const selectedManual = selected.find((o) => o.type === "manualPayment");
  const selectedHandle = selectedManual?.handle ?? selected[0]?.handle;
  if (!selectedHandle) return null;

  let message = HANDLE_TO_MESSAGE[selectedHandle];

  if (!message) {
    const manualOptions = available.filter((o) => o.type === "manualPayment");
    const index = manualOptions.findIndex((o) => o.handle === selectedHandle);
    if (index === 0) message = MESSAGE_CARD;
    else if (index === 1) message = MESSAGE_TRANSFER;
  }

  if (!message) return null;

  return (
    <Banner status="warning">
      <Text>{message}</Text>
    </Banner>
  );
}
