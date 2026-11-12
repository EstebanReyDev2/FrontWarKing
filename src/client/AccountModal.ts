import { PlayerStatsTree, UserMeResponse } from "@openfront/shared/ApiSchemas";
import { assetUrl } from "@openfront/shared/AssetUrls";
import { html, nothing, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { ClientEnv } from "src/client/ClientEnv";
import { hasLinkedIdentity } from "./AccountIdentity";
import { fetchPlayerById, getUserMe, invalidateUserMe } from "./Api";
import {
  discordLogin,
  googleLogin,
  linkGoogle,
  linkSteam,
  logOut,
  reauthAfterPortalChange,
  sendMagicLink,
  steamLogin,
} from "./Auth";
import "./components/baseComponents/stats/DiscordUserHeader";
import "./components/baseComponents/stats/PlayerGameHistoryView";
import type { PlayerGameHistoryCache } from "./components/baseComponents/stats/PlayerGameHistoryView";
import "./components/baseComponents/stats/PlayerStatsTable";
import "./components/baseComponents/stats/PlayerStatsTree";
import "./components/baseComponents/stats/SteamUserHeader";
import { BaseModal } from "./components/BaseModal";
import "./components/CopyButton";
import "./components/Difficulties";
import { googleLinkButton } from "./components/ui/GoogleLinkButton";
import { modalHeader } from "./components/ui/ModalHeader";
import { steamGlyph, steamLinkButton } from "./components/ui/SteamLinkButton";
import { desktopLinkGate, isDesktopShell } from "./DesktopShell";
import { gamePortal, type PortalUser } from "./GamePortal";
import "./GameStatsModal";
import { showInGameAlert } from "./InGameModal";
import { consumeLinkResult } from "./LinkResult";
import { consumeLoginResult, LoginResult } from "./LoginResult";
import "./PlayerProfileModal";
import { steamSDK } from "./SteamSDK";
import { playerProfileUrl } from "./utilities/PlayerProfileUrl";
import { currentPagePath, translateText } from "./Utils";

// Each login refusal says its own thing. Sharing one string was fine while
// email_exists was the only recognised result; a player refused because their
// account is pending deletion, or because a Steam OpenID response did not
// verify, must not be told their email is already in use.
const LOGIN_ERROR_KEYS: Record<LoginResult, string> = {
  email_exists: "account_modal.login_email_exists",
  deleted: "account_modal.login_deleted",
  error: "account_modal.login_error",
  no_account: "account_modal.login_no_account",
};

// Every opening of the account, numbered, so a superseded /users/@me read can
// tell it belongs to an earlier opening.
let accountOpenings = 0;

@customElement("account-modal")
export class AccountModal extends BaseModal {
  protected routerName = "account";

  @state() private email: string = "";
  @state() private isLoadingUser: boolean = false;
  // Counts openings, so a superseded /users/@me read is ignored.
  private openCount = 0;
  // The tab a link or caller asked for. BaseModal picks it when the tab is
  // listed at open, but the tabs wait for the account: a modal loaded after
  // the page's /users/@me broadcast doesn't know the player yet, and an
  // opening lists none while it reads /users/@me. Picked once that lands.
  private requestedTab: string | null = null;
  // Set on a portal (CrazyGames, Poki) when its user is signed in. Their
  // identity comes from the SDK, not our backend user object.
  @state() private portalUser: PortalUser | null = null;
  // One-shot outcome of a rejected sign-in, read from the `login=` router
  // arg on open. Reassigned on every open, so reopening clears it.
  @state() private loginError: LoginResult | undefined;
  private userMeResponse: UserMeResponse | null = null;
  private statsTree: PlayerStatsTree | null = null;
  // Preserves the Games tab's accumulated list + cursor across tab switches.
  private gameHistoryCache: PlayerGameHistoryCache | null = null;
  private gamesScrollTop = 0;
  private restoreGamesScrollAfterOpen = false;

  constructor() {
    super();

    document.addEventListener("userMeResponse", (event: Event) => {
      // A portal sign-in fires userMeResponse (via Main's auth listener);
      // re-fetch the SDK profile so the modal leaves the sign-in screen.
      this.refreshPortalUser();
      const customEvent = event as CustomEvent;
      if (customEvent.detail) {
        const previousPublicId = this.userMeResponse?.player?.publicId;
        this.userMeResponse = customEvent.detail as UserMeResponse;
        // Reset whenever the player identity changes (login, or switching to a
        // different account) so stats/history from the previous player don't
        // linger.
        if (this.userMeResponse?.player?.publicId !== previousPublicId) {
          this.resetPlayerData();
          this.requestUpdate();
        }
      } else {
        this.resetPlayerData();
        this.requestUpdate();
      }
    });
  }

  // Refresh the signed-in portal identity from the SDK. No-op off a
  // portal; drives isLinkedAccount() so the modal shows the profile.
  private refreshPortalUser() {
    if (!gamePortal.isOnGamePortal()) return;
    void gamePortal.getUserProfile().then((user) => {
      this.portalUser = user;
      this.requestUpdate();
    });
  }

  private hasAnyStats(): boolean {
    if (!this.statsTree) return false;
    // Check if statsTree has any data
    return (
      Object.keys(this.statsTree).length > 0 &&
      Object.values(this.statsTree).some(
        (gameTypeStats) =>
          gameTypeStats && Object.keys(gameTypeStats).length > 0,
      )
    );
  }

  protected renderHeaderSlot() {
    const isLoggedIn = !!this.userMeResponse?.user;
    const publicId = this.userMeResponse?.player?.publicId ?? "";
    return modalHeader({
      title: translateText("account_modal.title"),
      onBack: () => this.close(),
      ariaLabel: translateText("common.back"),
      // Not on Poki: the profile link leads players off Poki.
      rightContent:
        isLoggedIn &&
        !this.isLoadingUser &&
        publicId &&
        gamePortal.name() !== "poki"
          ? html`
              <copy-button
                class="shrink-0"
                .copyText=${playerProfileUrl(publicId)}
                .displayText=${translateText("player_profile.share")}
                .showVisibilityToggle=${false}
              ></copy-button>
            `
          : undefined,
    });
  }

  private isLinkedAccount(): boolean {
    // The portal identity only counts once the backend token exchange
    // produced a session — otherwise a failed exchange would show a dead
    // "connected as" view with no way to retry.
    return (
      hasLinkedIdentity(this.userMeResponse?.user) ||
      (!!this.portalUser && this.userMeResponse !== null)
    );
  }

  protected modalConfig() {
    if (this.isLoadingUser || !this.isLinkedAccount()) {
      return {};
    }
    return {
      tabs: [
        { key: "account", label: translateText("account_modal.tab_account") },
        { key: "stats", label: translateText("account_modal.tab_stats") },
        { key: "games", label: translateText("account_modal.tab_games") },
      ],
    };
  }

  protected renderBody(tab: string) {
    if (this.isLoadingUser) {
      return this.renderLoadingSpinner(
        translateText("account_modal.fetching_account"),
      );
    }
    if (!this.isLinkedAccount()) {
      return html`<div class="custom-scrollbar mr-1">
        ${gamePortal.isOnGamePortal()
          ? this.renderPortalSignIn()
          : this.renderLoginOptions()}
      </div>`;
    }
    return html`
      <div class="custom-scrollbar mr-1">
        <div class="p-6">${this.renderTab(tab)}</div>
      </div>
    `;
  }

  private renderTab(tab: string): TemplateResult {
    switch (tab) {
      case "stats":
        return this.renderStatsTab();
      case "games":
        return this.renderGamesTab();
      default:
        return this.renderAccountTab();
    }
  }

  // Email input + "get magic link" button used by the sign-in form.
  private renderEmailField(): TemplateResult {
    return html`
      <input
        type="email"
        .value=${this.email}
        @input=${this.handleEmailInput}
        placeholder=${translateText("account_modal.email_placeholder")}
        class="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white placeholder-white/20 focus:outline-none focus:ring-2 focus:ring-malibu-blue/50 focus:border-malibu-blue/50 transition-all font-medium hover:bg-white/10"
      />
      <o-button
        variant="primary"
        width="block"
        size="md"
        translationKey="account_modal.get_magic_link"
        @click=${this.handleSubmit}
      ></o-button>
    `;
  }

  private renderAccountTab(): TemplateResult {
    if (this.portalUser) {
      return this.renderPortalAccount(this.portalUser);
    }
    return html`
      <div class="flex flex-col gap-6">
        <div class="bg-white/5 rounded-xl border border-white/10 p-6">
          <div class="flex flex-col items-center gap-4">
            <div
              class="text-xs text-white/40 uppercase tracking-widest font-bold border-b border-white/5 pb-2 px-8"
            >
              ${translateText("account_modal.connected_as")}
            </div>
            <div class="flex items-center gap-8 justify-center flex-wrap">
              <discord-user-header
                .data=${this.userMeResponse?.user?.discord ?? null}
              ></discord-user-header>
              ${this.userMeResponse?.user?.steam
                ? html`<steam-user-header
                    .data=${this.userMeResponse.user.steam}
                  ></steam-user-header>`
                : null}
              ${this.renderLoggedInAs()}
            </div>
          </div>
        </div>
        ${this.renderDesktopLinkGateAction()}
      </div>
    `;
  }

  // Re-entry to the desktop shell's account-linking gate shown at first
  // launch. Absent entirely on plain web (no window.openfrontDesktop there),
  // present whenever the desktop bridge exposes a callable showLinkGate —
  // see desktopLinkGate() in DesktopShell.ts for why the guard is scoped
  // that way. Needed because the desktop app's menu bar will eventually be
  // hidden and the game runs fullscreen borderless, so a dismissed or
  // since-linked player needs another way back to that gate.
  private renderDesktopLinkGateAction(): TemplateResult | typeof nothing {
    if (desktopLinkGate() === null) return nothing;
    return html`
      <o-button
        variant="secondary"
        width="block"
        size="md"
        translationKey="account_modal.link_existing_account"
        @click=${this.handleShowLinkGate}
      ></o-button>
    `;
  }

  private handleShowLinkGate(): void {
    // The bare `void` form swallowed a rejection into an unhandled promise.
    // This is an IPC round trip to the Electron main process, so it can
    // genuinely reject (no window, a main-process throw); catching keeps the
    // failure visible in the console instead of surfacing as a button that
    // silently does nothing.
    desktopLinkGate()
      ?.showLinkGate()
      .catch((err) => {
        console.error("AccountModal: showLinkGate failed", err);
      });
  }

  // Portal "connected as" view: avatar + username from the SDK. No
  // Discord/Google/email link or logout (the portal owns the account and its
  // logout).
  private renderPortalAccount(user: PortalUser): TemplateResult {
    return html`
      <div class="flex flex-col gap-6">
        <div class="bg-white/5 rounded-xl border border-white/10 p-6">
          <div class="flex flex-col items-center gap-4">
            <div
              class="text-xs text-white/40 uppercase tracking-widest font-bold border-b border-white/5 pb-2 px-8"
            >
              ${translateText("account_modal.connected_as")}
            </div>
            <div class="flex flex-col items-center gap-3">
              <img
                src=${user.profilePictureUrl}
                alt=${user.username}
                class="w-16 h-16 rounded-full object-cover"
                referrerpolicy="no-referrer"
              />
              <div class="text-white text-lg font-medium">${user.username}</div>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Shown when a portal guest opens the modal: hand off to the portal's own
  // sign-in prompt (no Discord/Google/email on a portal).
  private renderPortalSignIn(): TemplateResult {
    return html`
      <div class="flex items-center justify-center p-6 min-h-full">
        <div
          class="w-full max-w-md bg-white/5 rounded-2xl border border-white/10 p-8 text-center"
        >
          <p class="text-white/50 text-sm font-medium mb-6">
            ${translateText("account_modal.sign_in_desc")}
          </p>
          <o-button
            variant="primary"
            width="block"
            size="md"
            translationKey="main.sign_in"
            @click=${this.handlePortalSignIn}
          ></o-button>
        </div>
      </div>
    `;
  }

  private renderStatsTab(): TemplateResult {
    return html`
      ${this.hasAnyStats()
        ? html`<player-stats-tree-view
            .statsTree=${this.statsTree}
          ></player-stats-tree-view>`
        : this.renderEmptyState("📊", translateText("account_modal.no_stats"))}
    `;
  }

  private renderGamesTab(): TemplateResult {
    const publicId = this.userMeResponse?.player?.publicId ?? "";
    if (!publicId) {
      return this.renderEmptyState(
        "🎮",
        translateText("account_modal.no_games"),
      );
    }
    return html`
      <player-game-history-view
        .publicId=${publicId}
        .cachedState=${this.gameHistoryCache?.publicId === publicId
          ? this.gameHistoryCache
          : null}
        @history-updated=${(e: CustomEvent<PlayerGameHistoryCache>) => {
          this.gameHistoryCache = e.detail;
        }}
        @view-stats=${(e: CustomEvent<{ gameId: string }>) =>
          this.openGameStats(e.detail.gameId)}
        @view-game=${(e: CustomEvent<{ gameId: string }>) =>
          void this.viewGame(e.detail.gameId)}
      ></player-game-history-view>
    `;
  }

  private renderEmptyState(icon: string, message: string): TemplateResult {
    return html`
      <div
        class="bg-white/5 rounded-xl border border-white/10 p-12 flex flex-col items-center justify-center text-center"
      >
        <div class="text-4xl mb-3">${icon}</div>
        <p class="text-white/60 text-sm">${message}</p>
      </div>
    `;
  }

  private renderLoggedInAs(): TemplateResult {
    const me = this.userMeResponse?.user;
    if (me?.discord) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          ${this.renderGoogleLink()} ${this.renderSteamLink()}
        </div>
      `;
    } else if (me?.google) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          <div class="text-white text-lg font-medium">
            ${translateText("account_modal.linked_account", {
              account_name: me.google.email,
            })}
          </div>
          ${this.renderSteamLink()}
        </div>
      `;
    } else if (me?.email) {
      return html`
        <div class="flex flex-col items-center gap-3 w-full">
          <div class="text-white text-lg font-medium">
            ${translateText("account_modal.linked_account", {
              account_name: me.email,
            })}
          </div>
          ${this.renderGoogleLink()} ${this.renderSteamLink()}
        </div>
      `;
    }
    return html``;
  }

  // Show the Google link state: a confirmation line when a Google account is
  // already linked, otherwise the button to link one.
  private renderGoogleLink(): TemplateResult {
    const google = this.userMeResponse?.user?.google;
    if (google) {
      const label = google.email
        ? translateText("account_modal.linked_to_google_email", {
            email: google.email,
          })
        : translateText("account_modal.linked_to_google");
      return html`
        <div class="flex items-center gap-2 text-white/70 text-sm">
          <img
            src=${assetUrl("images/GoogleLogo.svg")}
            alt=${translateText("account_modal.google_alt")}
            class="w-4 h-4"
          />
          <span>${label}</span>
        </div>
      `;
    }
    return this.renderLinkGoogleButton();
  }

  // Shown when logged in without a Google identity yet. Lets the user attach
  // Google to their existing account (we never auto-merge by email).
  private renderLinkGoogleButton(): TemplateResult {
    if (this.userMeResponse?.user?.google) return html``;
    return googleLinkButton(
      this.handleLinkGoogle,
      // The shell sends the player to the website for this (see linkGoogle
      // in Auth.ts); the caption has to say so.
      isDesktopShell()
        ? "account_modal.link_google_on_web"
        : "account_modal.link_google",
    );
  }

  // Steam link state (OPE-115): the linked account when there is one,
  // otherwise the button to link one.
  //
  // NOTE THE ASYMMETRY WITH GOOGLE, WHICH IS DELIBERATE: there is no unlink
  // control here, and there is a permanence warning on the button. Steam
  // recommends that users cannot self-unlink Steam from an external account,
  // so this is a one-way change that only support can reverse — the warning
  // has to be readable BEFORE the click, because afterwards the link exists.
  //
  // Not shown inside the desktop shell: a shell player already holds this
  // identity through the native Steam ticket.
  private renderSteamLink(): TemplateResult {
    if (isDesktopShell()) return html``;
    const steam = this.userMeResponse?.user?.steam;
    if (steam) {
      // The attached account is NAMED, not merely reported as linked: a wrong
      // link — the player's browser was signed into someone else's Steam when
      // they clicked — cannot be undone by them, so noticing it immediately is
      // the difference between a quick support fix and a permanent one.
      // Steam's own consent page is the first defence; this is the second.
      //
      // The persona and avatar come from the <steam-user-header> that
      // renderAccountTab already renders whenever user.steam is set, for every
      // branch including Steam-primary. Rendering a second one here showed it
      // TWICE to exactly the players this row is for — anyone Discord-,
      // Google- or email-primary with Steam linked.
      return html`
        <div class="flex flex-col items-center gap-1">
          <div class="flex items-center gap-2 text-white/70 text-sm">
            ${steamGlyph("w-4 h-4 shrink-0")}
            <span>${translateText("account_modal.linked_to_steam")}</span>
          </div>
          <span class="text-white/40 text-xs text-center">
            ${translateText("account_modal.link_steam_permanent")}
          </span>
        </div>
      `;
    }
    return html`
      <div class="w-full flex flex-col gap-1">
        ${steamLinkButton(this.handleLinkSteam)}
        <span class="text-white/40 text-xs text-center">
          ${translateText("account_modal.link_steam_permanent")}
        </span>
      </div>
    `;
  }

  private handleLinkSteam = async (): Promise<void> => {
    // On success linkSteam navigates to Steam; the result comes back as a
    // `link=...` router arg handled by consumeLinkResult. A false return means
    // we couldn't start it.
    const started = await linkSteam();
    if (!started) {
      await showInGameAlert(translateText("account_modal.link_steam_failed"));
    }
  };

  private async viewGame(gameId: string): Promise<void> {
    this.close();
    const encodedGameId = encodeURIComponent(gameId);
    const newUrl = currentPagePath(ClientEnv.gamePath(gameId));

    history.pushState({ join: gameId }, "", newUrl);
    window.dispatchEvent(
      new CustomEvent("join-changed", { detail: { gameId: encodedGameId } }),
    );
  }

  private openGameStats(gameId: string): void {
    this.gamesScrollTop = this.modalEl?.getScrollTop() ?? 0;
    const statsModal = document.querySelector<
      HTMLElement & { openFromAccount(gameId: string): void }
    >("game-stats-modal");
    statsModal?.openFromAccount(gameId);
  }

  public returnToGames(): void {
    this.restoreGamesScrollAfterOpen = true;
    this.open({ tab: "games" });
  }

  private async restoreGamesScroll(): Promise<void> {
    await this.updateComplete;
    await this.modalEl?.updateComplete;
    const historyView = this.querySelector<
      HTMLElement & { updateComplete?: Promise<boolean> }
    >("player-game-history-view");
    await historyView?.updateComplete;
    this.modalEl?.setScrollTop(this.gamesScrollTop);
  }

  private finishLoadingUser(opening: number): void {
    if (opening !== this.openCount) return;
    this.isLoadingUser = false;
    this.requestUpdate();
    // The tabs are listed now: pick the one asked for, if this account has
    // it. The modal can have been closed meanwhile; the tab is then left for
    // the next opening to decide.
    const tab = this.requestedTab;
    this.requestedTab = null;
    if (tab !== null && this.isOpen()) this.setActiveTab(tab);
    if (this.restoreGamesScrollAfterOpen) {
      this.restoreGamesScrollAfterOpen = false;
      void this.restoreGamesScroll();
    }
  }

  private resetPlayerData(): void {
    this.statsTree = null;
    this.gameHistoryCache = null;
    this.gamesScrollTop = 0;
    this.restoreGamesScrollAfterOpen = false;
  }

  // Shown when a sign-in was rejected because the provider's verified email
  // already belongs to an account. We deliberately don't name which provider
  // that account uses — the visitor has only proven control of the email.
  private renderLoginError(): TemplateResult {
    if (this.loginError === undefined) return html``;
    return html`
      <div
        class="mb-6 flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4"
      >
        <span class="text-red-400 text-lg leading-none" aria-hidden="true">
          &#9888;
        </span>
        <p class="flex-1 text-sm text-red-200">
          ${translateText(LOGIN_ERROR_KEYS[this.loginError])}
        </p>
        <button
          class="text-red-200/60 hover:text-red-200 text-lg leading-none"
          aria-label=${translateText("common.close")}
          @click=${() => (this.loginError = undefined)}
        >
          &times;
        </button>
      </div>
    `;
  }

  private renderLoginOptions() {
    // On the desktop shell both provider buttons open the shell's browser
    // link flow rather than an in-place OAuth redirect (see discordLogin /
    // googleLogin in Auth.ts), and the captions say so. Keyed on the shell
    // itself, not on the link-flow bridge: Auth.ts never builds the redirect
    // on ANY desktop shell (a shell too old to expose showLinkGate gets an
    // update prompt instead), so the web caption would be wrong on every one
    // of them.
    const viaBrowser = isDesktopShell();
    return html`
      <div class="flex items-center justify-center p-6 min-h-full">
        <div
          class="w-full max-w-md bg-white/5 rounded-2xl border border-white/10 p-8"
        >
          <div class="text-center mb-8">
            <div
              class="w-16 h-16 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-2xl flex items-center justify-center mx-auto mb-6 border border-white/10 shadow-inner"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                class="w-8 h-8 text-blue-400"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
                <polyline points="10 17 15 12 10 7"></polyline>
                <line x1="15" y1="12" x2="3" y2="12"></line>
              </svg>
            </div>
            <p class="text-white/50 text-sm font-medium">
              ${translateText("account_modal.sign_in_desc")}
            </p>
            ${viaBrowser
              ? html`<p class="text-white/40 text-xs">
                  ${translateText("account_modal.desktop_sign_in_desc")}
                </p>`
              : nothing}
          </div>

          ${this.renderLoginError()}

          <div class="space-y-6">
            <!-- Discord Login Button -->
            <button
              @click="${this.handleDiscordLogin}"
              class="w-full px-6 py-4 text-white bg-[#5865F2] hover:bg-[#4752C4] border border-transparent rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#5865F2] transition-colors duration-200 flex items-center justify-center gap-3 group relative overflow-hidden shadow-lg hover:shadow-[#5865F2]/20"
            >
              <img
                src=${assetUrl("images/DiscordLogo.svg")}
                alt="Discord"
                class="w-6 h-6 relative z-10"
              />
              <span class="font-bold relative z-10 tracking-wide"
                >${viaBrowser
                  ? translateText("account_modal.desktop_login_discord")
                  : translateText("main.login_discord") ||
                    translateText("account_modal.link_discord")}</span
              >
            </button>

            <!-- Google Login Button (Google brand guidelines: white surface,
                 dark text, the multicolor "G" mark) -->
            <button
              @click="${this.handleGoogleLogin}"
              class="w-full px-6 py-4 text-[#1f1f1f] bg-white hover:bg-[#f7f8f8] border border-[#dadce0] rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#4285F4] transition-colors duration-200 flex items-center justify-center gap-3 group relative overflow-hidden shadow-lg"
            >
              <img
                src=${assetUrl("images/GoogleLogo.svg")}
                alt=${translateText("account_modal.google_alt")}
                class="w-6 h-6 relative z-10"
              />
              <span class="font-bold relative z-10 tracking-wide"
                >${viaBrowser
                  ? translateText("account_modal.desktop_login_google")
                  : translateText("main.login_google")}</span
              >
            </button>

            <!-- Sign in through Steam. Hidden inside the desktop shell: the
                 player is already signed in there through the native Steam
                 ticket, so the button would be a no-op that looks like an
                 option. -->
            ${viaBrowser
              ? nothing
              : html`<button
                  @click="${this.handleSteamLogin}"
                  class="w-full px-6 py-4 text-white bg-[#1b2838] hover:bg-[#2a475e] border border-[#66c0f4]/30 rounded-xl focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#66c0f4] transition-colors duration-200 flex items-center justify-center gap-3 shadow-lg"
                >
                  ${steamGlyph("w-6 h-6 shrink-0")}
                  <span class="font-bold tracking-wide"
                    >${translateText("main.login_steam")}</span
                  >
                </button>`}

            <!-- Divider -->
            <div class="flex items-center gap-4 py-2">
              <div class="h-px bg-white/10 flex-1"></div>
              <span
                class="text-[10px] uppercase tracking-widest text-white/30 font-bold"
              >
                ${translateText("account_modal.or")}
              </span>
              <div class="h-px bg-white/10 flex-1"></div>
            </div>

            <!-- Email Recovery -->
            <div class="space-y-3">${this.renderEmailField()}</div>
          </div>

          <!-- Not on Steam: the Steam ticket re-creates the session on reload. -->
          ${steamSDK.isOnSteam()
            ? nothing
            : html`<div class="mt-8 text-center border-t border-white/10 pt-6">
                <button
                  @click="${this.handleLogout}"
                  class="text-[10px] font-bold text-white/20 hover:text-red-400 transition-colors uppercase tracking-widest pb-0.5"
                >
                  ${translateText("account_modal.clear_session")}
                </button>
              </div>`}
        </div>
      </div>
    `;
  }

  private handleEmailInput(e: Event) {
    const target = e.target as HTMLInputElement;
    this.email = target.value;
  }

  private async handleSubmit() {
    if (!this.email) {
      await showInGameAlert(translateText("account_modal.enter_email_address"));
      return;
    }

    const success = await sendMagicLink(this.email);
    await showInGameAlert(
      success
        ? translateText("account_modal.recovery_email_sent", {
            email: this.email,
          })
        : translateText("account_modal.failed_to_send_recovery_email"),
    );
  }

  // Portal sign-in: after their prompt completes, exchange the new token
  // for a session and refresh the modal so it shows the signed-in profile.
  private async handlePortalSignIn() {
    await gamePortal.showAuthPrompt();
    const profile = await gamePortal.getUserProfile();
    if (!profile) return; // prompt cancelled / still not signed in
    invalidateUserMe();
    await reauthAfterPortalChange();
    const userMe = await getUserMe();
    if (userMe) {
      this.userMeResponse = userMe;
    }
    this.portalUser = profile;
    this.requestUpdate();
  }

  private handleDiscordLogin() {
    discordLogin();
  }

  private handleGoogleLogin() {
    googleLogin();
  }

  private handleSteamLogin() {
    steamLogin();
  }

  private handleLinkGoogle = async (): Promise<void> => {
    // On success linkGoogle navigates to Google; the result comes back as a
    // `link=...` router arg handled by consumeLinkResult. A false return
    // means we couldn't start it.
    const started = await linkGoogle();
    if (!started) {
      await showInGameAlert(translateText("account_modal.link_google_failed"));
    }
  };

  protected onOpen(args?: Record<string, unknown>): void {
    const opening = (this.openCount = ++accountOpenings);
    this.isLoadingUser = true;
    this.requestedTab = typeof args?.tab === "string" ? args.tab : null;
    consumeLinkResult(args);
    this.loginError = consumeLoginResult(args);

    this.refreshPortalUser();

    void getUserMe()
      .then((userMe) => {
        if (userMe) {
          this.userMeResponse = userMe;
          if (this.userMeResponse?.player?.publicId) {
            this.loadPlayerProfile(this.userMeResponse.player.publicId);
          }
        }
        this.finishLoadingUser(opening);
      })
      .catch((err) => {
        console.warn("Failed to fetch user info in AccountModal.open():", err);
        this.finishLoadingUser(opening);
      });
    this.requestUpdate();
  }

  protected onClose(): void {
    this.dispatchEvent(
      new CustomEvent("close", { bubbles: true, composed: true }),
    );
  }

  private async handleLogout() {
    await logOut();
    this.close();
    // Refresh the page after logout to update the UI state
    window.location.reload();
  }

  private async loadPlayerProfile(publicId: string): Promise<void> {
    try {
      const data = await fetchPlayerById(publicId);
      if (!data) {
        this.requestUpdate();
        return;
      }

      this.statsTree = data.stats;

      this.requestUpdate();
    } catch (err) {
      console.warn("Failed to load player data:", err);
      this.requestUpdate();
    }
  }
}
