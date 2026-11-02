import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { getGuestIdentity, saveGuestNickname } from "./GuestIdentity";
import {
  createRoomCode,
  isValidRoomCode,
  JOIN_TIMEOUT_MS,
  MAX_PLAYERS,
  normalizeRoomCode,
} from "./LobbyRules";

type LobbyPlayer = { persistentID: string; nickname: string; host?: boolean };

/** UI-only lobby preview. It deliberately does not create a realtime session. */
@customElement("realtime-lobby-preview")
export class RealtimeLobbyPreview extends LitElement {
  createRenderRoot() {
    return this;
  }

  @state() private nickname = "";
  @state() private roomCode = "";
  @state() private joinCode = "";
  @state() private error = "";
  @state() private joining = false;
  @state() private players: LobbyPlayer[] = [];
  @state() private isHost = false;
  private joinTimer?: number;

  connectedCallback(): void {
    super.connectedCallback();
    this.nickname = getGuestIdentity().nickname;
    const inviteCode = new URLSearchParams(location.search).get("room");
    if (inviteCode !== null) this.joinCode = normalizeRoomCode(inviteCode);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.clearJoinTimer();
  }

  render() {
    return html`
      <section
        class="mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col gap-6 px-5 py-8 text-white sm:px-8"
      >
        <header class="flex flex-col gap-2">
          <button
            class="self-start rounded-lg border border-white/15 px-3 py-1.5 text-sm text-white/70 hover:bg-white/10"
            @click=${() => window.showPage?.("page-play")}
          >
            ← Menú principal
          </button>
          <p class="text-xs font-bold uppercase tracking-[0.2em] text-aquarius">
            Lobby de prueba
          </p>
          <h1 class="text-3xl font-bold sm:text-4xl">
            ${this.roomCode ? "Sala de juego" : "Jugar con compañeros"}
          </h1>
          <p class="max-w-2xl text-sm text-white/65">
            Vista previa con datos ficticios. Todavía no se conecta a Supabase
            ni inicia una partida.
          </p>
        </header>

        ${this.roomCode ? this.renderRoom() : this.renderEntry()}
      </section>
    `;
  }

  private renderEntry() {
    return html`
      <label
        class="flex max-w-md flex-col gap-2 text-sm text-white/75"
        for="lobby-nickname"
      >
        Tu apodo
        <input
          id="lobby-nickname"
          class="rounded-lg border border-white/15 bg-black/25 px-3 py-2 text-base text-white outline-none focus:border-aquarius"
          maxlength="24"
          minlength="1"
          required
          .value=${this.nickname}
          @input=${(event: InputEvent) => {
            this.nickname = (event.target as HTMLInputElement).value;
            this.error = "";
          }}
        />
      </label>
      <div
        class="grid w-full min-w-0 grid-cols-1 auto-rows-min items-start gap-5 md:grid-cols-2"
      >
        <form
          class="flex min-w-0 flex-col gap-4 rounded-2xl border border-white/10 bg-surface/80 p-5 shadow-xl"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            this.createRoom();
          }}
        >
          <h2 class="text-xl font-semibold">Crear una sala</h2>
          <button
            class="rounded-lg bg-malibu-blue px-4 py-3 font-bold text-white hover:bg-aquarius"
            type="submit"
          >
            Crear sala
          </button>
          <p class="text-xs text-white/50">Máximo ${MAX_PLAYERS} jugadores.</p>
        </form>

        <form
          class="flex min-w-0 flex-col gap-4 rounded-2xl border border-white/10 bg-surface/80 p-5 shadow-xl"
          @submit=${(event: SubmitEvent) => {
            event.preventDefault();
            this.joinRoom();
          }}
        >
          <h2 class="text-xl font-semibold">Unirse con un código</h2>
          <label class="flex flex-col gap-2 text-sm text-white/75">
            Código de sala
            <input
              class="rounded-lg border border-white/15 bg-black/25 px-3 py-2 font-mono text-lg uppercase tracking-[0.2em] text-white outline-none focus:border-aquarius"
              maxlength="6"
              minlength="6"
              placeholder="ABC234"
              required
              .value=${this.joinCode}
              @input=${(event: InputEvent) => {
                this.joinCode = (event.target as HTMLInputElement).value;
                this.error = "";
              }}
            />
          </label>
          ${this.error
            ? html`<p class="text-sm text-red-300" role="alert">
                ${this.error}
              </p>`
            : nothing}
          <button
            class="rounded-lg border border-white/15 bg-white/10 px-4 py-3 font-bold text-white hover:bg-white/15 disabled:cursor-wait disabled:opacity-60"
            type="submit"
            ?disabled=${this.joining}
          >
            ${this.joining ? "Buscando sala…" : "Unirme"}
          </button>
          ${this.joining
            ? html`<p class="text-xs text-white/50">
                Esperando respuesta del host (3 segundos)…
              </p>`
            : nothing}
        </form>
      </div>
    `;
  }

  private renderRoom() {
    const inviteURL = new URL(window.location.href);
    inviteURL.searchParams.set("lobby-preview", "");
    inviteURL.searchParams.set("room", this.roomCode);
    return html`
      <section
        class="flex flex-col gap-5 rounded-2xl border border-white/10 bg-surface/80 p-5 shadow-xl sm:p-7"
        aria-label="Sala ${this.roomCode}"
      >
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p class="text-sm text-white/60">Código de sala</p>
            <p class="font-mono text-4xl font-bold tracking-[0.2em] text-white">
              ${this.roomCode}
            </p>
          </div>
          <button
            class="rounded-lg border border-white/15 bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/15"
            @click=${() =>
              void navigator.clipboard?.writeText(inviteURL.toString())}
          >
            Copiar enlace
          </button>
        </div>
        <div class="flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <h2 class="text-xl font-semibold">Jugadores</h2>
            <span class="text-sm text-white/60"
              >${this.players.length}/${MAX_PLAYERS}</span
            >
          </div>
          <ul class="flex flex-col gap-2">
            ${this.players.map(
              (player) => html`<li
                class="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 px-4 py-3"
              >
                <span>${player.nickname}</span>
                ${player.host
                  ? html`<span
                      class="rounded bg-aquarius/15 px-2 py-1 text-xs font-semibold text-aquarius"
                      >HOST</span
                    >`
                  : nothing}
              </li>`,
            )}
          </ul>
        </div>
        <p
          class="rounded-lg border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100"
        >
          ${this.isHost
            ? "Compartí el enlace o el código con tus compañeros."
            : "Conectado a una sala de demostración; la conexión real llega en B3-3."}
        </p>
        <div class="flex flex-wrap justify-between gap-3">
          <button
            class="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/10"
            @click=${() => this.leaveRoom()}
          >
            Volver
          </button>
          <button
            class="rounded-lg bg-malibu-blue/40 px-4 py-2 text-sm font-bold text-white/60"
            disabled
            title="El arranque se implementa en B3-3"
          >
            Empezar (B3-3)
          </button>
        </div>
      </section>
    `;
  }

  private createRoom(): void {
    this.nickname = saveGuestNickname(this.nickname);
    if (!this.nickname) {
      this.error = "Ingresá un apodo válido.";
      return;
    }
    this.roomCode = createRoomCode();
    this.isHost = true;
    this.players = [
      {
        persistentID: getGuestIdentity().persistentID,
        nickname: this.nickname,
        host: true,
      },
    ];
    this.error = "";
  }

  private joinRoom(): void {
    const code = normalizeRoomCode(this.joinCode);
    this.joinCode = code;
    this.error = "";
    if (!isValidRoomCode(code)) {
      this.error = "Ingresá un código válido de 6 caracteres.";
      return;
    }
    if (!this.nickname.trim()) {
      this.error = "Ingresá tu apodo antes de unirte.";
      return;
    }

    this.nickname = saveGuestNickname(this.nickname);
    this.joining = true;
    this.clearJoinTimer();

    // The preview route simulates the host reply. B3-3 replaces this with the
    // actual `hello` handshake and its production timeout.
    const inviteCode = new URLSearchParams(location.search).get("room");
    if (inviteCode !== null && normalizeRoomCode(inviteCode) === code) {
      this.joinTimer = window.setTimeout(() => this.acceptDemoJoin(code), 150);
      return;
    }

    this.joinTimer = window.setTimeout(() => {
      this.joining = false;
      this.error = "Sala no encontrada o host desconectado";
    }, JOIN_TIMEOUT_MS);
  }

  private acceptDemoJoin(code: string): void {
    this.joining = false;
    this.roomCode = code;
    this.isHost = false;
    this.players = [
      { persistentID: "demo-host", nickname: "Host de prueba", host: true },
      {
        persistentID: getGuestIdentity().persistentID,
        nickname: this.nickname,
      },
    ];
    this.error = "";
  }

  private leaveRoom(): void {
    this.clearJoinTimer();
    this.roomCode = "";
    this.players = [];
    this.isHost = false;
    this.error = "";
  }

  private clearJoinTimer(): void {
    if (this.joinTimer !== undefined) {
      window.clearTimeout(this.joinTimer);
      this.joinTimer = undefined;
    }
  }
}
