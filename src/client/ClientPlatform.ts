import type {
  ClientDevice,
  ClientPlatform,
} from "@openfront/shared/WireSchemas";
import { Platform } from "./Platform";

// Phase 1 removed the desktop (Steam) shell and the web game portals, so the
// open web is the only place this client runs. The signal is kept because the
// value travels on the wire in the join payload.
// TODO Fase 2: drop the field with the rest of the join contract.
export function clientPlatform(): ClientPlatform {
  return "web";
}

// OS-based, not width- or pointer-based: a narrow desktop window or a touch
// laptop is still a desktop, and the question the metric answers is which
// kind of hardware the player is on.
export function clientDevice(): ClientDevice {
  return Platform.isIOS || Platform.isAndroid ? "mobile" : "desktop";
}
