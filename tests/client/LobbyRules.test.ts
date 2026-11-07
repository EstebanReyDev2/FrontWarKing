import { describe, expect, it } from "vitest";
import {
  createRoomCode,
  isValidRoomCode,
  JOIN_TIMEOUT_MS,
  MAX_PLAYERS,
  normalizeRoomCode,
  ROOM_CODE_ALPHABET,
} from "../../src/client/lobby/LobbyRules";

describe("realtime lobby rules", () => {
  it("uses the approved player cap and handshake timeout", () => {
    expect(MAX_PLAYERS).toBe(7);
    expect(JOIN_TIMEOUT_MS).toBe(3000);
  });

  it("normalizes invite codes and rejects ambiguous or malformed characters", () => {
    expect(normalizeRoomCode("  ab c234  ")).toBe("ABC234");
    expect(isValidRoomCode("ABC234")).toBe(true);
    for (const ambiguous of ["0", "O", "I", "L", "1"]) {
      expect(isValidRoomCode(`ABC${ambiguous}34`)).toBe(false);
    }
    for (const retained of ["S", "5", "B", "8"]) {
      expect(isValidRoomCode(`ABC${retained}4D`)).toBe(true);
    }
    expect(isValidRoomCode("ABC23")).toBe(false);
  });

  it("generates six-character codes from the approved 31-character alphabet", () => {
    const code = createRoomCode((length) => new Uint8Array(length).fill(30));

    expect(code).toBe(ROOM_CODE_ALPHABET[30].repeat(6));
    expect(code).toHaveLength(6);
    expect(isValidRoomCode(code)).toBe(true);
    expect(ROOM_CODE_ALPHABET).toHaveLength(31);
  });
});
