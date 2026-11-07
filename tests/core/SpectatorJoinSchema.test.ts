import { ClientJoinMessageSchema } from "@openfront/shared/WireSchemas";
import { describe, expect, it } from "vitest";

const JOIN = {
  type: "join" as const,
  token: "9f0f4b3a-0d2e-4a1f-8f0b-1c2d3e4f5a6b",
  gameID: "AbCd1234",
  username: "caster",
  clanTag: null,
  turnstileToken: null,
};

describe("ClientJoinMessageSchema — spectator", () => {
  it("requires an explicit clanTag key, which may be null", () => {
    expect(
      ClientJoinMessageSchema.safeParse({ ...JOIN, clanTag: null }).success,
    ).toBe(true);

    const withoutClanTag = { ...JOIN } as Partial<typeof JOIN>;
    delete withoutClanTag.clanTag;
    expect(ClientJoinMessageSchema.safeParse(withoutClanTag).success).toBe(
      false,
    );
  });

  it("accepts a spectator join", () => {
    const parsed = ClientJoinMessageSchema.parse({ ...JOIN, spectator: true });
    expect(parsed.spectator).toBe(true);
  });

  it("leaves the flag undefined when omitted, so a normal join plays", () => {
    const parsed = ClientJoinMessageSchema.parse(JOIN);
    expect(parsed.spectator).toBeUndefined();
  });

  it("rejects a non-boolean spectator", () => {
    expect(
      ClientJoinMessageSchema.safeParse({ ...JOIN, spectator: "yes" }).success,
    ).toBe(false);
  });
});
