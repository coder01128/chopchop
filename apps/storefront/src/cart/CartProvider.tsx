import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import {
  addLine,
  cartTotal,
  removeLine,
  setLineQty,
  type CartLine,
} from '../storefront-model';

/**
 * The cart lives in local state and nowhere else.
 *
 * Nothing is written until checkout, which is what makes an abandoned cart cost
 * nothing: no row, no anonymous auth user, no phantom in the seller's queue.
 * The order is created in one call at the moment the buyer commits.
 */
interface CartApi {
  lines: CartLine[];
  total: number;
  add: (line: CartLine) => void;
  remove: (variantId: string) => void;
  setQty: (variantId: string, qty: number) => void;
  clear: () => void;
}

const CartContext = createContext<CartApi | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [lines, setLines] = useState<CartLine[]>([]);

  const add = useCallback((line: CartLine) => setLines((current) => addLine(current, line)), []);
  const remove = useCallback(
    (variantId: string) => setLines((current) => removeLine(current, variantId)),
    [],
  );
  const setQty = useCallback(
    (variantId: string, qty: number) => setLines((current) => setLineQty(current, variantId, qty)),
    [],
  );
  const clear = useCallback(() => setLines([]), []);

  const value = useMemo<CartApi>(
    () => ({ lines, total: cartTotal(lines), add, remove, setQty, clear }),
    [lines, add, remove, setQty, clear],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartApi {
  const cart = useContext(CartContext);
  if (!cart) throw new Error('useCart() called outside a <CartProvider>.');
  return cart;
}
