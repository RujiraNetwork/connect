import { aminoDocSchema } from "@rujira/connect-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import fixture from "./fixtures/thor-eip712.json";
import { validateThorTypedData, thorTypedData } from "./thor-eip712";
import { typedData } from "./transactions";

const amino = aminoDocSchema.parse(fixture.amino);
describe("THORChain Ethereum app encoding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("hashes the live Cosmos Web3 domain using the independent viem reference", () => {
    const data = validateThorTypedData(amino, fixture.typed);
    expect(data.domain.verifyingContract).toBe("cosmos");
    expect(typedData(data).digest).toBe(fixture.digest);
  });
  it("rejects changed values and schemas that omit approved fields", () => {
    const changed = structuredClone(fixture.typed);
    changed.message.msg0.value.amount[0] = { amount: "2", denom: "rune" };
    expect(() => validateThorTypedData(amino, changed)).toThrow("changed");
    const omitted = structuredClone(fixture.typed);
    omitted.types.Tx = omitted.types.Tx.filter(
      (field) => field.name !== "memo"
    );
    expect(() => validateThorTypedData(amino, omitted)).toThrow("omitted");
    const domain = structuredClone(fixture.typed);
    domain.types.EIP712Domain = domain.types.EIP712Domain.filter(
      (field) => field.name !== "chainId"
    );
    expect(() => validateThorTypedData(amino, domain)).toThrow("omitted");
  });
  it("validates app-prepared typed data without any network call", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(thorTypedData(amino, fixture.typed)).toEqual(fixture.typed);
    expect(() => thorTypedData(amino, undefined)).toThrow(
      "must include prepared"
    );
    const changed = structuredClone(fixture.typed);
    changed.domain.name = "Other app";
    expect(() => thorTypedData(amino, changed)).toThrow(
      "unexpected EIP-712 domain"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
