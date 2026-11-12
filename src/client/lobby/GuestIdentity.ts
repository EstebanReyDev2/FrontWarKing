import { generateID } from "@openfront/shared/SharedUtil";

const PERSISTENT_ID_KEY = "frontwars.lobby.persistentID";
const NICKNAME_KEY = "frontwars.lobby.nickname";

export type GuestIdentity = {
  persistentID: string;
  nickname: string;
};

/** Loads the local guest identity, creating its stable ID on first use. */
export function getGuestIdentity(
  storage: Storage = localStorage,
): GuestIdentity {
  let persistentID = storage.getItem(PERSISTENT_ID_KEY);
  if (persistentID === null || persistentID.trim() === "") {
    persistentID = generateID();
    storage.setItem(PERSISTENT_ID_KEY, persistentID);
  }

  return {
    persistentID,
    nickname: storage.getItem(NICKNAME_KEY)?.trim() ?? "",
  };
}

/** Stores the guest's chosen lobby nickname without surrounding whitespace. */
export function saveGuestNickname(
  nickname: string,
  storage: Storage = localStorage,
): string {
  const normalizedNickname = nickname.trim();
  storage.setItem(NICKNAME_KEY, normalizedNickname);
  return normalizedNickname;
}
