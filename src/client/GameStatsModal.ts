import { html } from "lit";
import { customElement, state } from "lit/decorators.js";
import "./components/baseComponents/stats/GameInfoView";
import { BaseModal } from "./components/BaseModal";
import "./components/CopyButton";
import { modalHeader } from "./components/ui/ModalHeader";
import { translateText } from "./Utils";

@customElement("game-stats-modal")
export class GameStatsModal extends BaseModal {
  protected routerName = "stats";

  @state() private gameId: string | null = null;
  private openedFrom: "account" | "clan" | "profile" | null = null;
  // Whose profile the game was opened from, when opened from a profile.
  private profilePublicId: string | null = null;

  protected modalConfig() {
    return { maxWidth: "960px" };
  }

  protected renderHeaderSlot() {
    return modalHeader({
      title: translateText("game_list.stats"),
      onBack: () => this.back(),
      ariaLabel: translateText("common.back"),
      rightContent: this.gameId
        ? html`
            <copy-button
              compact
              class="shrink-0"
              .copyText=${this.gameId}
              .displayText=${this.gameId}
              .showVisibilityToggle=${false}
            ></copy-button>
          `
        : undefined,
    });
  }

  protected renderBody() {
    return html`
      <div class="px-3 py-4 sm:px-6 sm:py-6 lg:px-8 lg:py-7">
        <game-info-view .gameId=${this.gameId}></game-info-view>
      </div>
    `;
  }

  protected onOpen(args?: Record<string, unknown>): void {
    this.gameId =
      typeof args?.gameID === "string" && args.gameID.length > 0
        ? args.gameID
        : null;
  }

  protected onClose(): void {
    this.gameId = null;
    this.openedFrom = null;
    this.profilePublicId = null;
  }

  public openFromAccount(gameId: string): void {
    this.openedFrom = "account";
    this.profilePublicId = null;
    this.open({ gameID: gameId });
  }

  public openFromClan(gameId: string): void {
    this.openedFrom = "clan";
    this.profilePublicId = null;
    this.open({ gameID: gameId });
  }

  // `profilePublicId` is whose profile the game was listed on: the player's
  // own profile counts as their own history.
  public openFromProfile(gameId: string, profilePublicId?: string): void {
    this.openedFrom = "profile";
    this.profilePublicId = profilePublicId ?? null;
    this.open({ gameID: gameId });
  }

  private back(): void {
    const openedFrom = this.openedFrom;
    this.close();
    if (openedFrom === "account") {
      document
        .querySelector<HTMLElement & { returnToGames(): void }>("account-modal")
        ?.returnToGames();
    } else if (openedFrom === "profile") {
      document
        .querySelector<HTMLElement & { returnToGames(): void }>(
          "player-profile-modal",
        )
        ?.returnToGames();
    } else if (openedFrom === "clan") {
      document
        .querySelector<HTMLElement & { returnToGameHistory(): void }>(
          "clan-modal",
        )
        ?.returnToGameHistory();
    }
  }
}
