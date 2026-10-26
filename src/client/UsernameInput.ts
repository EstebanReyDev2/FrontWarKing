import { UserMeResponse } from "@openfront/shared/ApiSchemas";
import { html, LitElement } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { translateText } from "../client/Utils";
import { getUserMe } from "./Api";
import { verifiedBadge } from "./components/ui/VerifiedBadge";
import { gamePortal } from "./GamePortal";
import { showInGameAlert, showInGameConfirm } from "./InGameModal";
import {
  accountNameHeld,
  accountVerifiedName,
  clampUsername,
  genAnonUsername,
  LAPSE_NOTICE_KEY,
  lapseNoticeMarker,
  looksGenerated,
  resolvePlayerName,
  verifiedClaimGrace,
  verifiedNameOptIn,
  type ClaimGrace,
  type ResolvedPlayerName,
} from "./PlayerName";
import { steamSDK } from "./SteamSDK";
import {
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  validateUsername,
} from "./validations/username";

interface LangSelectorLike {
  currentLang?: string;
  translations?: Record<string, string>;
  defaultTranslations?: Record<string, string>;
}

const usernameKey: string = "username";
const useVerifiedNameKey: string = "useVerifiedName";
// "The stored username is one we generated, not one the player chose." Written
// alongside the name itself; see usernameIsGenerated.
const usernameIsGeneratedKey: string = "usernameIsGenerated";
// Whether the verified-name default may apply to this profile at all. Decided
// once, the first time this code runs here, and never revisited. See
// resolveVerifiedDefaultCohort.
const verifiedDefaultAllowedKey: string = "verifiedNameDefaultAllowed";
// The reserved name we have already warned this device about; see
// announceLapse. Holds a name, not a boolean, so a later lapse still speaks up.
// Defined in PlayerName so boot sequencing can read the same key — it has to
// ask whether a notice is owed before this component writes it.
const lapseNoticeKey: string = LAPSE_NOTICE_KEY;
// setTimeout stores its delay in a 32-bit signed int. Anything larger does not
// saturate — Node warns and fires after 1ms.
const MAX_TIMEOUT_MS = 2_147_483_647;

// Decide, once per profile, whether the verified-name default is allowed to
// apply here — and record it, because the evidence is destroyed moments later.
//
// The default exists for players who have never seen the toggle. But "no
// stored preference" does not mean that on its own: before the default
// existed the toggle rendered off and the only writer of the preference was a
// click, so an existing eligible subscriber who looked at it and left it alone
// is in exactly the same state as a brand-new install. Turning that player's
// real account name on without them touching anything is a silent public
// identity change, which is the opposite of what a privacy default is for.
//
// A stored username is the only durable trace a profile leaves, and
// validateAndStore is its only writer — so at construction, before
// loadStoredUsername runs, "no stored username" means "this profile has never
// played here". That is the whole discriminator.
//
// It has to be recorded rather than recomputed: one boot later the new profile
// has a stored username too and would be indistinguishable from an old one, so
// a re-mount or a reload would revoke the default it had just granted.
function resolveVerifiedDefaultCohort(onGamePortal: boolean): void {
  // A portal never persists a username (see validateAndStore), so there is
  // no history to read, and verifiedActive is gated off there regardless.
  if (onGamePortal) return;
  if (localStorage.getItem(verifiedDefaultAllowedKey) !== null) return;
  // An answered preference makes the default moot either way; record the
  // decision anyway so this never re-runs against a profile that has since
  // acquired a stored username.
  const answered = localStorage.getItem(useVerifiedNameKey) !== null;
  const hasPlayedHere = localStorage.getItem(usernameKey) !== null;
  localStorage.setItem(
    verifiedDefaultAllowedKey,
    String(!answered && !hasPlayedHere),
  );
}

// Same format the account modal's grace warning uses, so the two places that
// name this deadline read alike. Local rather than shared: every component in
// this codebase that shows a date formats its own (e.g. SubscriptionPanel,
// SubscriptionPanel, UsernamePanel).
function formatClaimDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Shared by the input and the verified chip, which swap places: any drift in
// box or text metrics shows up as the name jumping on toggle.
const NAME_BOX =
  "min-w-0 flex-1 h-full max-h-[44px] rounded-lg bg-transparent px-2 sm:px-3";
// `line-height: normal` because that is what an <input> uses for its editor
// box; the span only lands on the same pixel when it sizes from font metrics
// too. Any fixed leading drifts a pixel under some fonts.
const NAME_TEXT =
  "text-xl/[normal] sm:text-2xl/[normal] font-medium tracking-wider " +
  "[text-shadow:0_1px_2px_rgba(0,0,0,0.9)]";

@customElement("username-input")
export class UsernameInput extends LitElement {
  @state() private baseUsername: string = "";
  // Playing under the account's verified bare name (sub-only). The free-form
  // name stays in baseUsername/localStorage so unchecking restores it.
  @state() private verifiedActive: boolean = false;
  private userMe: UserMeResponse | false | null = null;
  // The raw Steam persona, once it lands. Kept alongside the free-form name so
  // resolution sees the same inputs the seed did (see resolvedName).
  private persona: string | null = null;
  // Minted once so re-resolving is stable: the player must never watch their
  // placeholder name change under them.
  private readonly generatedName: string = genAnonUsername();
  // Whether the name in baseUsername is one we generated rather than one the
  // player chose. Persisted, because one localStorage string cannot tell the
  // two apart and the reseed rule turns entirely on the difference.
  private usernameIsGenerated: boolean = false;
  // The bare name still reserved for this player and its deadline, while a
  // lapsed subscription's grace clock runs. Null whenever nothing is at stake.
  @state() private claimGrace: ClaimGrace | null = null;
  // Fires once, at the reservation's deadline, so a client left open across it
  // drops the notice instead of counting down to a date already past. The
  // grace value itself only changes on account events, which a sitting client
  // never receives.
  private claimGraceTimer: ReturnType<typeof setTimeout> | null = null;

  // Portal identities are account-owned, so never persist their names locally.
  private readonly onGamePortal = gamePortal.isOnGamePortal();
  // Steam identity is fixed for the session (no login/logout events like
  // the portals), so it's only used to seed the name once in connectedCallback.
  private readonly onSteam = steamSDK.isOnSteam();

  @property({ type: String }) validationError: string = "";
  private _isValid: boolean = true;
  private _lastValidatedLang: string | null = null;

  // Resolves once the one-shot Steam name-seed has settled (or immediately for
  // non-Steam players). The join flow awaits this before reading getUsername()
  // so a fast join can't start the game under the generated anon name before
  // the Steam persona lands. Always resolves — never rejects — so a failed or
  // slow getUser() falls back to the generated name instead of blocking.
  private steamSeedReady: Promise<void> = Promise.resolve();

  // Remove static styles since we're using Tailwind

  createRenderRoot() {
    // Disable shadow DOM to allow Tailwind classes to work
    return this;
  }

  constructor() {
    super();
    // Before anything can write a username: this reads the absence of one as
    // "this profile is new", and loadStoredUsername destroys that evidence.
    resolveVerifiedDefaultCohort(this.onGamePortal);
    // Account state for the verified-name toggle. Same document-level pattern
    // as AccountModal; Main dispatches this after auth resolves and on
    // portal sign-in.
    document.addEventListener("userMeResponse", (event: Event) => {
      this.userMe = (event as CustomEvent).detail as UserMeResponse | false;
      this.applyVerifiedPreference();
    });
  }

  // The bare name this player may play verified under, or null when
  // ineligible. The rule itself lives in PlayerName so the join path and the
  // resolver can't disagree with the toggle about who qualifies.
  private verifiedName(): string | null {
    return accountVerifiedName(this.userMe);
  }

  // Turn the toggle on iff the player has not opted out AND is still eligible;
  // silently off otherwise (logout, lapsed sub, TEMPORARY rename).
  //
  // "Has not opted out" rather than "opted in": the preference is tri-state,
  // and an absent one defaults on only for a profile we identified as new
  // (see verifiedNameOptIn and resolveVerifiedDefaultCohort). An existing
  // player with no stored preference is treated as having declined.
  //
  // The default is deliberately never written back into the preference. The
  // cohort marker records what we observed about the profile; recording an
  // opt-in the player never expressed is a different thing, and it is the
  // value account-level settings sync would later propagate.
  private applyVerifiedPreference() {
    this.verifiedActive =
      !this.onGamePortal &&
      verifiedNameOptIn(
        localStorage.getItem(useVerifiedNameKey),
        localStorage.getItem(verifiedDefaultAllowedKey) === "true",
      ) &&
      this.verifiedName() !== null;
    this.refreshClaimGrace();
    this.requestUpdate();
    this.validateAndStore();
  }

  // Re-derive the reservation, re-arm the clock, and speak up if the phase
  // changed. Every path that can move this state goes through here — an
  // account event, the expiry timer, and reconnecting — so none of them can
  // do two of the three and silently skip the other. That is exactly how the
  // banner once escalated with no alert behind it, and how reconnecting past
  // a deadline left the stale wording in place.
  private refreshClaimGrace() {
    this.claimGrace = verifiedClaimGrace(this.userMe);
    this.scheduleClaimGraceExpiry();
    this.announceLapse();
  }

  // Escalate the notice the moment the reservation lapses.
  //
  // verifiedClaimGrace is evaluated only when account state changes, and a
  // client sitting on the main menu receives none — so without this the notice
  // would keep saying "reserved until {date}" after that date. Re-deriving from
  // the same userMe flips it to the at-risk wording; nothing arms afterwards,
  // because at-risk has no further deadline to wait for.
  //
  // The delay must be clamped by us. A 30-day reservation exceeds setTimeout's
  // 32-bit millisecond field, and Node does not saturate — it warns and fires
  // after 1ms, which would re-arm in a tight loop. Capping below the limit
  // makes an over-long wait fire early, re-derive to the same non-null value
  // and re-arm for the remainder: two timers across a 30-day grace, not
  // millions.
  private scheduleClaimGraceExpiry() {
    if (this.claimGraceTimer !== null) {
      clearTimeout(this.claimGraceTimer);
      this.claimGraceTimer = null;
    }
    const grace = this.claimGrace;
    if (grace === null) return;
    const ms = grace.expiresAt.getTime() - Date.now();
    if (ms <= 0) return;
    const delay = Math.min(ms, MAX_TIMEOUT_MS);
    this.claimGraceTimer = setTimeout(() => {
      this.claimGraceTimer = null;
      this.refreshClaimGrace();
    }, delay);
  }

  // Say it once, the first time we see a reservation with a clock running.
  //
  // Keyed on the name rather than a bare "already announced" flag, and cleared
  // whenever the player is eligible again, so a resubscribe-then-lapse cycle
  // announces the second lapse too. A flag alone would announce once per
  // install and then stay quiet through every later lapse.
  //
  // Deliberately scoped to the case where something is actually at stake. A
  // logout or a TEMPORARY#### rename also turns the toggle off, but neither
  // has a deadline attached and neither costs the player a name, so neither
  // interrupts them.
  private announceLapse() {
    if (this.onGamePortal) return;
    if (this.verifiedName() !== null) {
      localStorage.removeItem(lapseNoticeKey);
      return;
    }
    const grace = this.claimGrace;
    if (grace === null) return;
    // Keyed on the phase as well as the name; lapseNoticeMarker owns that rule
    // now, because boot sequencing has to reach the same verdict from the same
    // inputs (see lapseNoticeDue) and two copies of the format would let one
    // side think a notice is pending while the other thinks it is spent.
    const marker = lapseNoticeMarker(grace);
    if (localStorage.getItem(lapseNoticeKey) === marker) return;
    const key = grace.atRisk
      ? "username.lapse_notice_at_risk"
      : "username.lapse_notice";
    const message = translateText(key, {
      name: grace.name,
      date: formatClaimDate(grace.expiresAt),
    });
    // translateText echoes the key back until <lang-selector> has fetched its
    // translation files, and auth can resolve first. Announcing here would
    // show the player the literal string "username.lapse_notice" AND burn the
    // marker, so the real notice would never fire — for a one-shot warning
    // that is the only channel a Steam-only account has.
    //
    // Bailing costs the alert for this session, not for good: the marker is
    // left unwritten, so it fires normally on the next launch. Nothing
    // re-enters this when the language files land — applyVerifiedPreference
    // only re-runs on account events, and LangSelector's requestUpdate
    // re-renders the standing banner without coming back through here. Only
    // reachable on a non-English locale, since `en` is a static import.
    if (message === key) return;
    // Recorded before the dialog, not after: the alert resolves only when the
    // player dismisses it, and an unawaited promise that never settles would
    // let a second announcement through.
    localStorage.setItem(lapseNoticeKey, marker);
    void showInGameAlert(message);
  }

  private async handleVerifiedToggle() {
    // verifiedActive implies eligible (applyVerifiedPreference), so this
    // covers both turning off and an eligible turn-on.
    if (this.verifiedActive || this.verifiedName() !== null) {
      this.verifiedActive = !this.verifiedActive;
      localStorage.setItem(useVerifiedNameKey, String(this.verifiedActive));
      this.validateAndStore();
      return;
    }
    // Ineligible — the toggle can't turn on.
    const player = this.userMe === false ? undefined : this.userMe?.player;
    const status = player?.usernameStatus;
    if (accountNameHeld(this.userMe)) {
      // Subscribed, but someone else holds the bare name: they display as
      // base.disc and cannot play with the check until they rename. Say so,
      // then offer the form (spec, 10 Sept 2026).
      const rename = await showInGameConfirm(
        translateText("username.verified_held_body", {
          name: player?.usernameBase ?? "",
        }),
        {
          heading: translateText("username.verified_heading"),
          variant: "warning",
          confirmText: translateText("username.verified_held_confirm"),
        },
      );
      if (rename) window.location.hash = "modal=change-username";
      return;
    }
    if (status === "premium" || status === "indefinite") {
      // Subscribed but no usable name yet (never set, or TEMPORARY####):
      // send them straight to the username form.
      window.location.hash = "modal=change-username";
      return;
    }
    await showInGameAlert(translateText("username.verified_sub_required"), {
      heading: translateText("username.verified_heading"),
    });
  }

  /**
   * The name this player will play under, and where it came from. The single
   * seam join paths read — they take the whole result rather than asking the
   * component two separate questions and risking them disagreeing.
   *
   * `verifiedActive` already folds in eligibility and the portal exclusion
   * (see applyVerifiedPreference), so it is the opt-in the resolver wants.
   */
  public resolvedName(): ResolvedPlayerName {
    return resolvePlayerName({
      verifiedName: this.verifiedName(),
      verifiedOptIn: this.verifiedActive,
      storedName: this.baseUsername,
      persona: this.persona,
      generatedName: this.generatedName,
    });
  }

  public getUsername(): string {
    return this.resolvedName().name;
  }

  /** True when the player is playing under their verified account name. */
  public isVerified(): boolean {
    return this.resolvedName().verified;
  }

  // Resolves once the one-shot Steam name-seed has settled (immediately for
  // non-Steam players, or once nothing was left to seed). The join flow awaits
  // this before reading getUsername() so a fast join reads the Steam persona
  // rather than the interim generated anon name. Never blocks: the underlying
  // chain always resolves, even when getUser() fails or the persona is invalid.
  public whenSeeded(): Promise<void> {
    return this.steamSeedReady;
  }

  connectedCallback() {
    super.connectedCallback();
    // Refresh unconditionally, before the fetch below can short-circuit.
    // disconnectedCallback clears the timer but leaves userMe set, so a
    // detach/reattach of the same instance takes the `userMe !== null` early
    // return and never reaches applyVerifiedPreference. Re-arming alone was
    // not enough: if the deadline passed while detached, the stale grace made
    // the scheduler bail on `ms <= 0` without ever flipping to the at-risk
    // wording or announcing it. Re-deriving first is what closes that.
    //
    // This path looks unreachable today — <play-page> is hidden by class
    // toggling rather than removed — so treat it as keeping the comment
    // honest rather than fixing a live bug.
    this.refreshClaimGrace();
    // userMeResponse is dispatched once and can fire before this connects.
    // Cached, so this re-reads that response rather than refetching.
    void getUserMe().then((me) => {
      if (this.userMe !== null) return;
      this.userMe = me;
      this.applyVerifiedPreference();
    });
    // Captured before loadStoredUsername(), which — when nothing is stored —
    // fills in a fresh anon username AND persists it immediately. Checking
    // localStorage afterwards would therefore never see it as empty.
    //
    // Reseedable, not one-shot: the old gate was "nothing stored at all", so a
    // single launch before the persona landed (or before this fix, when a
    // decorated persona was rejected outright) left a generated Anon… name in
    // localStorage that nothing would ever replace. A name we generated is
    // ours to overwrite; a name the player typed never is.
    const reseedable = this.onSteam && this.storedNameIsGenerated();
    this.loadStoredUsername();
    // On a portal the account username is applied here but never persisted
    // (see loadStoredUsername / validateAndStore), so logging out — which
    // reloads the whole page — falls back to a fresh guest username instead of
    // keeping the account name. addAuthListener only fires on login; portals
    // refresh the page on logout, so there is no logout event to handle.
    gamePortal.getUsername().then((username) => {
      if (username) {
        this.baseUsername = clampUsername(username);
        this.usernameIsGenerated = false;
        this.validateAndStore();
      }
    });
    gamePortal.addAuthListener((user) => {
      if (user) {
        this.baseUsername = clampUsername(user.username);
        this.usernameIsGenerated = false;
        this.validateAndStore();
      }
    });
    // Seed the in-game name from the Steam persona whenever the name in hand
    // is one we generated. Unlike the portals, Steam persists normally (see
    // validateAndStore's onGamePortal guard), and there's no logout event to
    // handle since the Steam identity is fixed for the session.
    if (reseedable) {
      // The anon name loadStoredUsername() just generated. Only overwrite it if
      // the player hasn't typed their own name while getUser() was in flight,
      // so a late Steam result never clobbers a name they entered.
      const generated = this.baseUsername;
      // Store the seeding promise so the join path can await it (see
      // whenSeeded). The chain never rejects — on any failure we keep the
      // generated name — so awaiting it can only delay, never block, a join.
      this.steamSeedReady = steamSDK
        .getUser()
        .then((user) => {
          // Both halves matter. The text check catches the player typing
          // while getUser() was in flight; the ownership flag catches them
          // typing and then restoring the same text, which leaves the name
          // looking untouched but makes it theirs (see handleUsernameChange).
          if (this.baseUsername !== generated) return;
          if (!this.usernameIsGenerated) return;
          this.persona = user?.name ?? null;
          // storedName is deliberately null: whatever is stored is a name we
          // generated, which this is entitled to replace. So this is branch 3
          // then 4 — the sanitised persona, or the same generated name back
          // when none of it survives. Either way the player can start a game.
          const seeded = resolvePlayerName({
            verifiedName: null,
            verifiedOptIn: false,
            storedName: null,
            persona: this.persona,
            generatedName: generated,
          });
          this.baseUsername = seeded.name;
          // Still ours if nothing of the persona survived, so a later launch
          // (or a renamed Steam account) gets another go at it.
          this.usernameIsGenerated = seeded.source === "generated";
          this.validateAndStore();
        })
        .catch(() => {
          // Swallow: keep the generated name so the player can always play.
        });
    }
  }

  disconnectedCallback() {
    if (this.claimGraceTimer !== null) {
      clearTimeout(this.claimGraceTimer);
      this.claimGraceTimer = null;
    }
    super.disconnectedCallback();
  }

  protected updated(): void {
    // Re-validate when translations become available or language changes,
    // since initial validation may run before translations are loaded.
    if (this.validationError) {
      const langSelector = document.querySelector<LangSelectorLike & Element>(
        "lang-selector",
      );
      const lang = langSelector?.currentLang;
      const hasTranslations =
        langSelector?.translations ?? langSelector?.defaultTranslations;
      if (hasTranslations && lang && lang !== this._lastValidatedLang) {
        this._lastValidatedLang = lang;
        this.validateAndStore();
      }
    }
  }

  private loadStoredUsername() {
    // On a portal the username is never persisted, so ignore any stored value
    // and start from a fresh guest name; the account name (if signed in) is
    // applied afterwards in connectedCallback.
    const storedUsername = this.onGamePortal
      ? null
      : localStorage.getItem(usernameKey);
    // No persona yet — it arrives asynchronously and reseeds in
    // connectedCallback, so this settles on the stored or generated name.
    const resolved = resolvePlayerName({
      verifiedName: null,
      verifiedOptIn: false,
      storedName: storedUsername,
      persona: null,
      generatedName: this.generatedName,
    });
    this.baseUsername = resolved.name;
    this.usernameIsGenerated = storedUsername
      ? this.storedNameIsGenerated()
      : resolved.source === "generated";
    this.validateAndStore();
  }

  // Whether the name already in localStorage is one we generated.
  //
  // Installs that predate the flag have no key to read, so fall back to the
  // name's shape: genAnonUsername produces "Anon" + a word from a fixed bank,
  // which is recognisable. That is what un-poisons a Steam install whose one
  // and only seed attempt happened before this fix — without it, everyone who
  // has already launched the game keeps their guest name forever.
  private storedNameIsGenerated(): boolean {
    const stored = localStorage.getItem(usernameKey);
    if (!stored) return true;
    const flag = localStorage.getItem(usernameIsGeneratedKey);
    return flag === null ? looksGenerated(stored) : flag === "true";
  }

  render() {
    return html`
      <div class="flex items-center w-full h-full gap-1.5 sm:gap-2">
        ${this.renderNameControl()}
      </div>
      <!-- One positioned slot, stacked. An error and the reservation reminder
           are not alternatives: the error is transient and self-inflicted
           (mid-edit on a free-form name), while the reminder is a 30-day
           countdown the player cannot recover once it lapses. Hiding the
           second behind the first put the time-critical one last. -->
      ${this.validationError || this.claimGrace
        ? html`<div
            class="absolute top-full left-0 z-50 w-full mt-1 flex flex-col gap-1"
          >
            ${this.validationError
              ? html`<div
                  id="username-validation-error"
                  class="w-full px-3 py-2 text-sm font-medium border border-red-500/50 rounded-lg bg-red-900/90 text-red-200 backdrop-blur-md shadow-lg"
                >
                  ${this.validationError}
                </div>`
              : null}
            ${this.renderClaimGrace()}
          </div>`
        : null}
    `;
  }

  // A standing reminder for as long as the reservation lasts. The one-time
  // notice announces the change; this is what a player who dismissed it — or
  // who was not at the keyboard when it fired — still sees, every launch,
  // until either they resubscribe or the name is gone.
  //
  // Amber rather than red: nothing is broken and play is not blocked. It
  // stacks under any validation error rather than replacing it — a player
  // mid-edit on an invalid name is exactly who still needs to know their
  // reserved name is expiring. Positioning lives on the shared wrapper.
  private renderClaimGrace() {
    const grace = this.claimGrace;
    if (grace === null) return null;
    return html`<div
      id="username-claim-grace"
      class="w-full px-3 py-2 text-sm font-medium border border-amber-500/40 rounded-lg bg-amber-950/90 text-amber-200 backdrop-blur-md shadow-lg"
    >
      ${translateText(
        grace.atRisk ? "username.claim_at_risk" : "username.claim_reserved",
        { name: grace.name, date: formatClaimDate(grace.expiresAt) },
      )}
    </div>`;
  }

  // Name field. Verified play swaps the free-text input for a badge-led chip so
  // the state reads as "this is my account name", not "the input broke".
  private renderNameControl() {
    return html`
      ${this.verifiedActive
        ? this.renderVerifiedChip()
        : this.renderNameInput()}
      <!-- The buttons differ in width, so this resizes the name field — which
           is transparent and left-aligned, so only its invisible right edge
           moves. -->
      <div class="no-game-portal shrink-0 h-full max-h-[44px]">
        ${this.verifiedActive
          ? this.renderUseCustomButton()
          : this.renderUseVerifiedButton()}
      </div>
    `;
  }

  private renderVerifiedChip() {
    return html`
      <div
        class="flex items-center gap-1.5 ${NAME_BOX}"
        title=${translateText("username.verified_active_hint")}
      >
        <!-- Check trails the name, as everywhere else it is rendered. The name
             shrinks rather than grows, so the mark keeps hugging it. -->
        <span class="min-w-0 truncate text-white ${NAME_TEXT}"
          >${this.verifiedName() ?? ""}</span
        >
        ${verifiedBadge("w-5 h-5 sm:w-6 sm:h-6", "text-aquarius")}
      </div>
    `;
  }

  private renderUseCustomButton() {
    return html`
      <button
        type="button"
        class="flex h-full aspect-square items-center justify-center rounded-lg border border-white/15 bg-black/25 text-white/70 transition-colors hover:border-white/30 hover:bg-black/40 hover:text-white cursor-pointer"
        title=${translateText("username.verified_use_custom")}
        aria-label=${translateText("username.verified_use_custom")}
        @click=${this.handleVerifiedToggle}
      >
        <!-- Icon only; the label lives in title/aria-label. Sized to the
             verified badge so the two buttons read as a pair. -->
        <svg
          viewBox="0 0 24 24"
          class="w-5 h-5"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9"></path>
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
        </svg>
      </button>
    `;
  }

  private renderNameInput() {
    return html`
      <input
        type="text"
        .value=${this.baseUsername}
        @input=${this.handleUsernameChange}
        placeholder="${translateText("username.enter_username")}"
        minlength="${MIN_USERNAME_LENGTH}"
        maxlength="${MAX_USERNAME_LENGTH}"
        aria-label=${translateText("username.enter_username")}
        class="text-left text-white placeholder-white/50 transition-colors text-ellipsis hover:bg-white/5 focus:bg-white/5 focus:outline-none focus:ring-2 focus:ring-malibu-blue/60 ${NAME_BOX} ${NAME_TEXT}"
      />
    `;
  }

  private renderUseVerifiedButton() {
    const eligible = this.verifiedName() !== null;
    const held = accountNameHeld(this.userMe);
    const hint = held
      ? translateText("username.verified_held_hint", {
          name:
            (this.userMe === false ? undefined : this.userMe?.player)
              ?.usernameBase ?? "",
        })
      : translateText("username.verified_use_hint");
    return html`
      <button
        type="button"
        class="group flex h-full w-full items-center justify-center gap-1.5 rounded-lg border px-2 transition-colors cursor-pointer select-none ${eligible
          ? "border-malibu-blue/50 bg-malibu-blue/10 hover:border-malibu-blue/80 hover:bg-malibu-blue/20"
          : "border-white/10 bg-black/20 hover:border-white/25 hover:bg-black/35"}"
        title=${hint}
        aria-pressed="false"
        @click=${this.handleVerifiedToggle}
      >
        ${verifiedBadge(
          "w-5 h-5 transition-colors",
          eligible
            ? "text-aquarius"
            : "text-white/25 group-hover:text-white/45",
          null,
        )}
        <span
          class="hidden sm:inline text-sm font-medium whitespace-nowrap transition-colors ${eligible
            ? "text-white"
            : "text-white/60 group-hover:text-white/90"}"
          >${translateText("username.verified_use")}</span
        >
      </button>
    `;
  }

  private handleUsernameChange(e: Event) {
    const input = e.target as HTMLInputElement;
    const originalValue = input.value;
    const val = originalValue.replace(/[[\]]/g, "");
    if (originalValue !== val) {
      input.value = val;
      // Show toast when brackets are removed
      window.dispatchEvent(
        new CustomEvent("show-message", {
          detail: {
            message: translateText("username.invalid_chars"),
            color: "red",
            duration: 2000,
          },
        }),
      );
    }
    this.baseUsername = val;
    // Typed by the player, so no longer ours to reseed over.
    this.usernameIsGenerated = false;
    this.validateAndStore();
  }

  private validateAndStore() {
    // The free-form field's own contents, not resolvedName(): resolution falls
    // through an emptied field to the persona or a generated name, and play
    // must stay blocked until the player puts a name back.
    const trimmedBase = this.baseUsername.trim();

    // Playing under the verified account name: it's server-issued, so skip
    // free-form validation and leave the stored free-form name untouched for
    // when the toggle turns off.
    if (this.verifiedActive) {
      this._isValid = true;
      this.validationError = "";
      this.emitValidity();
      return;
    }

    const result = validateUsername(trimmedBase);
    this._isValid = result.isValid;
    if (result.isValid) {
      // Never persist on a portal: keeping localStorage empty means a logout
      // (page reload) restores a guest username instead of the account name.
      if (!this.onGamePortal) {
        localStorage.setItem(usernameKey, trimmedBase);
        // Written with the name, never separately: a stale flag would either
        // strand a player on a generated name or overwrite one they chose.
        localStorage.setItem(
          usernameIsGeneratedKey,
          String(this.usernameIsGenerated),
        );
      }
      this.validationError = "";
    } else {
      this.validationError = result.error ?? "";
    }
    this.emitValidity();
  }

  // Broadcast play-eligibility so action buttons can disable themselves.
  private emitValidity() {
    window.dispatchEvent(
      new CustomEvent("username-validity-change", {
        detail: { isValid: this.canPlay() },
      }),
    );
  }

  // Play-eligibility: syntax-valid.
  public canPlay(): boolean {
    return this._isValid;
  }
}
