import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../src/db.js", () => ({
  query: (...args: unknown[]) => query(...args),
  pool: { query: (...args: unknown[]) => query(...args), end: async () => {} },
}));

const walletRpc = vi.fn();
vi.mock("../src/walletRpc.js", () => ({
  walletRpc: (...a: unknown[]) => walletRpc(...a),
  withWallet: async (_n: string, fn: () => Promise<unknown>) => fn(),
  daemonRpc: async () => ({ height: 1_000_000 }),
  createViewOnlyWallet: async () => {},
  walletRpcVersion: async () => 1,
}));

import { createInvoice, InvoiceInputError, WalletNotReadyError } from "../src/invoices.js";

const ready = { id: "m1", wallet_name: "m_1", wallet_ready_at: "2026-10-11T22:00:00.000Z" };

beforeEach(() => {
  query.mockReset();
  walletRpc.mockReset();
});

describe("createInvoice wallet readiness", () => {
  it("refuses while the wallet is still being provisioned", async () => {
    await expect(createInvoice({ ...ready, wallet_ready_at: null }, { amount_xmr: "1.0" })).rejects.toThrow(
      WalletNotReadyError
    );
    // Nothing was quoted, minted or written.
    expect(walletRpc).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed when a caller forgets to carry the field", async () => {
    await expect(
      createInvoice({ id: "m1", wallet_name: "m_1" } as never, { amount_xmr: "1.0" })
    ).rejects.toThrow(WalletNotReadyError);
  });

  it("mints once the wallet is ready", async () => {
    walletRpc.mockImplementation(async (method: string) => {
      if (method === "create_address") return { address: "8sub", address_index: 7 };
      return {};
    });
    query.mockResolvedValue({
      rows: [{ id: "inv1", status: "pending", expires_at: "2026-10-11T23:00:00.000Z" }],
      rowCount: 1,
    });
    const inv = await createInvoice(ready, { amount_xmr: "0.5" });
    expect(inv.subaddress).toBe("8sub");
    expect(inv.amountAtomic).toBe(500_000_000_000n);
  });

  it("still rejects bad input before anything else", async () => {
    await expect(createInvoice(ready, { amount_xmr: "-1" })).rejects.toThrow(InvoiceInputError);
  });
});
