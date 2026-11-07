import { afterEach, describe, expect, it } from "vitest";
import {
  getGuestIdentity,
  saveGuestNickname,
} from "../../src/client/lobby/GuestIdentity";

afterEach(() => {
  localStorage.clear();
});

describe("guest lobby identity", () => {
  it("creates and persists a stable persistentID", () => {
    const first = getGuestIdentity();
    const second = getGuestIdentity();

    expect(first.persistentID).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(second.persistentID).toBe(first.persistentID);
    expect(first.nickname).toBe("");
  });

  it("loads and saves the chosen nickname without surrounding whitespace", () => {
    const persistentID = getGuestIdentity().persistentID;

    expect(saveGuestNickname("  Esteban  ")).toBe("Esteban");
    expect(getGuestIdentity()).toEqual({
      persistentID,
      nickname: "Esteban",
    });
  });

  it("replaces a blank stored persistentID", () => {
    localStorage.setItem("frontwars.lobby.persistentID", "  ");

    const identity = getGuestIdentity();

    expect(identity.persistentID).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(identity.persistentID).not.toBe("  ");
  });
});
