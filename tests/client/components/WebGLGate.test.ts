import { afterEach, describe, expect, it } from "vitest";
import {
  WebGLGate,
  type WebGLGateStatus,
} from "../../../src/client/components/WebGLGate";

describe("webgl-gate", () => {
  let gate: WebGLGate | undefined;

  afterEach(() => {
    gate?.remove();
    window.openfrontDesktop = undefined;
  });

  async function mount(status: WebGLGateStatus): Promise<WebGLGate> {
    gate = new WebGLGate();
    gate.status = status;
    document.body.appendChild(gate);
    await gate.updateComplete;
    return gate;
  }

  it("shows browser instructions on the web", async () => {
    await mount("unsupported");

    expect(gate!.textContent).toContain("Google Chrome");
    expect(gate!.textContent).not.toContain("desktop_webgl_gate");
  });




  it("omits the quit button on a shell without quit()", async () => {
    window.openfrontDesktop = {};
    await mount("unsupported");

    expect(gate!.querySelector("button")).toBeNull();
  });

});
