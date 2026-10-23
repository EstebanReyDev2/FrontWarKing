import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { InsufficientCurrency } from "../Cosmetics";
import { translateText } from "../Utils";
import "./ConfirmDialog";

/**
 * Shown when the player can't afford something with the in-game currencies.
 * Set `.info` to display it and clear it on `@close`. Dismiss-only: the store
 * that used to sell top-ups was removed in phase 1.
 */
@customElement("insufficient-currency-dialog")
export class InsufficientCurrencyDialog extends LitElement {
  @property({ attribute: false }) info: InsufficientCurrency | null = null;

  createRenderRoot() {
    return this;
  }

  private close() {
    this.dispatchEvent(new CustomEvent("close"));
  }

  render() {
    const info = this.info;
    if (!info) return nothing;
    return html`<confirm-dialog
      .heading=${translateText("store.insufficient_currency_title", {
        currency: info.currency,
      })}
      .message=${translateText("store.insufficient_currency_body", {
        amount: info.shortfall,
        currency: info.currency,
        item: info.item,
      })}
      variant="warning"
      .wide=${true}
      .showClose=${true}
      .buttons=${"none"}
      @cancel=${() => this.close()}
    ></confirm-dialog>`;
  }
}
