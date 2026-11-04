import { GameMapType } from "@openfront/engine-api/game/Maps.gen";
import type { EventBus } from "@openfront/shared/EventBus";
import type { WireGameStartInfo } from "@openfront/shared/WireSchemas";
import { html, LitElement, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { allLobbyMaps, curatedMaps } from "../CuratedMaps";
import { isPreviewRoute } from "../RouteMode";
import { getGuestIdentity, saveGuestNickname } from "./GuestIdentity";
import { LaunchRealtimeGameEvent } from "./LobbyEvents";
import {
  createRoomCode,
  isValidRoomCode,
  MAX_PLAYERS,
  normalizeRoomCode,
} from "./LobbyRules";
import type { LobbyStart } from "./LobbySchemas";
import { LobbyRoomCollisionError, LobbySession } from "./LobbySession";
import {
  canStartPreviewGame,
  createPreviewGameStartInfo,
  type PreviewRosterPlayer,
} from "./PreviewGameConfig";

type LobbyPlayer = PreviewRosterPlayer & { host?: boolean; testPeer?: boolean };

declare global {
  interface Window {
    __debugGameStartInfo?: WireGameStartInfo;
  }
}

/** Pre-game lobby preview; starting a game remains deliberately disabled. */
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
  @state() private selectedMap = curatedMaps[0].map;
  @state() private showAllMaps = false;
  @state() private gameStartInfo: WireGameStartInfo | null = null;
  @property({ attribute: false }) eventBus: EventBus | null = null;
  private lobbySession?: LobbySession;

  connectedCallback(): void {
    super.connectedCallback();
    this.nickname = getGuestIdentity().nickname;
    const inviteCode = new URLSearchParams(location.search).get("room");
    if (inviteCode !== null) {
      this.joinCode = normalizeRoomCode(inviteCode);
      if (this.nickname) queueMicrotask(() => void this.joinRoom());
    }
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    void this.leaveRoom();
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
            Lobby realtime efímero. La partida todavía no se inicia.
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
            ?disabled=${this.joining}
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
    const canStart = canStartPreviewGame(
      this.isHost,
      this.lobbySession?.roster.length ?? 0,
    );
    const showTestPeerControls = this.isHost && isPreviewRoute();
    const canAddTestPeer =
      showTestPeerControls && this.players.length < MAX_PLAYERS;
    const visibleMaps = this.showAllMaps
      ? allLobbyMaps
      : curatedMaps.map(({ map }) => map);
    const selectedMapLabel = this.selectedMap;
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
                ${showTestPeerControls && player.testPeer
                  ? html`<button
                      class="ml-auto rounded border border-white/15 px-2 py-1 text-xs text-white/70 hover:bg-white/10"
                      aria-label="Quitar ${player.nickname}"
                      @click=${() => this.removeTestPeer(player.persistentID)}
                    >
                      Quitar
                    </button>`
                  : nothing}
              </li>`,
            )}
          </ul>
          ${showTestPeerControls
            ? html`<div class="flex flex-wrap items-center gap-2">
                <button
                  class="self-start rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
                  ?disabled=${!canAddTestPeer}
                  title=${canAddTestPeer
                    ? "Agrega un jugador local de prueba; no conecta a realtime."
                    : `Límite de ${MAX_PLAYERS} jugadores alcanzado.`}
                  @click=${() => this.addTestPeer()}
                >
                  Agregar jugador de prueba
                </button>
                ${this.players.length >= MAX_PLAYERS
                  ? html`<span class="text-xs text-white/50"
                      >Límite de ${MAX_PLAYERS} jugadores alcanzado.</span
                    >`
                  : nothing}
              </div>`
            : nothing}
        </div>
        <section
          class="flex flex-col gap-3 rounded-xl border border-white/10 bg-black/15 p-4"
          aria-label="Configuración de partida"
        >
          <div class="flex flex-wrap items-center justify-between gap-3">
            <label
              class="flex min-w-0 flex-1 flex-col gap-2 text-sm text-white/75"
            >
              Mapa
              <select
                class="rounded-lg border border-white/15 bg-neutral-900 px-3 py-2 text-base text-white"
                .value=${this.selectedMap}
                @change=${(event: Event) => {
                  this.selectedMap = (event.target as HTMLSelectElement)
                    .value as GameMapType;
                  this.gameStartInfo = null;
                  delete window.__debugGameStartInfo;
                }}
              >
                ${visibleMaps.map(
                  (map) =>
                    html`<option
                      value=${map}
                      ?selected=${map === this.selectedMap}
                    >
                      ${map}
                    </option>`,
                )}
              </select>
            </label>
            <button
              class="self-end rounded-lg border border-white/15 px-3 py-2 text-sm hover:bg-white/10"
              aria-pressed=${this.showAllMaps}
              @click=${() => this.toggleAllMaps()}
            >
              ${this.showAllMaps
                ? "Ver mapas recomendados"
                : "Ver todos los mapas"}
            </button>
          </div>
          ${!this.showAllMaps
            ? html`<p class="text-xs text-white/50">
                ${curatedMaps.find(({ map }) => map === this.selectedMap)
                  ?.reason ?? "Mapa recomendado para partidas de oficina."}
              </p>`
            : nothing}
        </section>
        ${this.error
          ? html`<p class="text-sm text-red-300" role="alert">${this.error}</p>`
          : nothing}
        <p
          class="rounded-lg border border-amber-300/20 bg-amber-300/10 px-4 py-3 text-sm text-amber-100"
        >
          ${this.gameStartInfo
            ? `Config lista: ${selectedMapLabel} — esperando B3-3b.`
            : this.isHost
              ? "Compartí el enlace o el código con tus compañeros."
              : "Conectado a la sala. El inicio realtime llega en el siguiente sub-bloque."}
        </p>
        <div class="flex flex-wrap justify-between gap-3">
          <button
            class="rounded-lg border border-white/15 px-4 py-2 text-sm hover:bg-white/10"
            @click=${() => this.leaveRoom()}
          >
            Volver
          </button>
          ${this.isHost
            ? html`<button
                class="rounded-lg bg-malibu-blue px-4 py-2 text-sm font-bold text-white hover:bg-aquarius disabled:cursor-not-allowed disabled:opacity-50"
                ?disabled=${!canStart}
                title=${canStart
                  ? "Preparar configuración (no inicia la partida)"
                  : "Se necesitan al menos 2 jugadores."}
                @click=${() => void this.prepareStart()}
              >
                Empezar
              </button>`
            : nothing}
        </div>
        ${this.isHost && !canStart
          ? html`<p class="text-sm text-amber-100/80" role="status">
              Necesitás al menos 2 jugadores para empezar.
            </p>`
          : nothing}
      </section>
    `;
  }

  private async createRoom(): Promise<void> {
    if (this.joining) return;
    this.nickname = saveGuestNickname(this.nickname);
    if (!this.nickname) {
      this.error = "Ingresá un apodo válido.";
      return;
    }
    this.error = "";
    this.gameStartInfo = null;
    delete window.__debugGameStartInfo;
    this.joining = true;
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = createRoomCode();
        try {
          this.lobbySession = await LobbySession.createHost({
            roomCode: code,
            clientID: getGuestIdentity().persistentID,
            nickname: this.nickname,
            onRoster: (players) => {
              this.players = this.mergeTestPeers(players);
            },
            onError: (error) => (this.error = error.message),
            onGameStart: (start) => this.onGameStart(start),
          });
          if (!this.isConnected) {
            await this.lobbySession.close();
            this.lobbySession = undefined;
            return;
          }
          this.roomCode = code;
          this.isHost = true;
          this.joining = false;
          return;
        } catch (error) {
          if (!(error instanceof LobbyRoomCollisionError)) throw error;
        }
      }
      throw new Error("No se pudo reservar un código de sala. Probá de nuevo.");
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.joining = false;
    }
  }

  private async joinRoom(): Promise<void> {
    if (this.joining) return;
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
    try {
      const session = await LobbySession.joinPeer({
        roomCode: code,
        clientID: getGuestIdentity().persistentID,
        nickname: this.nickname,
        onRoster: (players) => (this.players = players),
        onHostLost: () => {
          void (async () => {
            await this.leaveRoom();
            this.error =
              "El host se desconectó. La sala ya no está disponible.";
          })();
        },
        onStartTimeout: () => this.onStartTimeout(),
        onGameStart: (start) => this.onGameStart(start),
        onError: (error) => (this.error = error.message),
      });
      if (!this.isConnected) {
        await session.close();
        return;
      }
      this.lobbySession = session;
      this.roomCode = code;
      this.isHost = false;
      this.joining = false;
      this.error = "";
    } catch (error) {
      this.joining = false;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  private async leaveRoom(): Promise<void> {
    const session = this.lobbySession;
    this.lobbySession = undefined;
    await session?.close();
    this.roomCode = "";
    this.players = [];
    this.isHost = false;
    this.error = "";
    this.gameStartInfo = null;
    delete window.__debugGameStartInfo;
  }

  private toggleAllMaps(): void {
    this.showAllMaps = !this.showAllMaps;
    if (
      !this.showAllMaps &&
      !curatedMaps.some(({ map }) => map === this.selectedMap)
    ) {
      this.selectedMap = curatedMaps[0].map;
    }
    this.gameStartInfo = null;
    delete window.__debugGameStartInfo;
  }

  private async prepareStart(): Promise<void> {
    const session = this.lobbySession;
    if (!session || !canStartPreviewGame(this.isHost, session.roster.length))
      return;
    const gameStartInfo = createPreviewGameStartInfo(
      this.selectedMap,
      session.roster,
    );
    this.gameStartInfo = gameStartInfo;
    window.__debugGameStartInfo = gameStartInfo;
    try {
      await session.startGame(gameStartInfo);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.gameStartInfo = null;
      delete window.__debugGameStartInfo;
    }
  }

  private onGameStart(start: LobbyStart): void {
    this.gameStartInfo = start.gameStartInfo;
    window.__debugGameStartInfo = start.gameStartInfo;
    this.classList.add("is-game-started");
    if (this.eventBus === null) {
      this.classList.remove("is-game-started");
      this.error = "No se pudo iniciar la partida: falta el canal de eventos.";
    } else {
      this.eventBus.emit(
        new LaunchRealtimeGameEvent(
          start,
          getGuestIdentity().persistentID,
          this.nickname,
        ),
      );
    }
    const session = this.lobbySession;
    this.lobbySession = undefined;
    void session?.close();
  }

  private onStartTimeout(): void {
    void (async () => {
      await this.leaveRoom();
      this.error = "El host cerró antes de empezar.";
    })();
  }

  private addTestPeer(): void {
    if (!this.isHost || !isPreviewRoute() || this.players.length >= MAX_PLAYERS)
      return;
    const lastTestPeerNumber = this.players.reduce((highest, player) => {
      const match = /^test-peer-(\d+)$/.exec(player.persistentID);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 1);
    const nextNumber = lastTestPeerNumber + 1;
    this.players = [
      ...this.players,
      {
        persistentID: `test-peer-${nextNumber}`,
        nickname: `Jugador de prueba ${nextNumber}`,
        testPeer: true,
      },
    ];
    this.gameStartInfo = null;
    delete window.__debugGameStartInfo;
  }

  private removeTestPeer(persistentID: string): void {
    this.players = this.players.filter(
      (player) => player.persistentID !== persistentID || !player.testPeer,
    );
    this.gameStartInfo = null;
    delete window.__debugGameStartInfo;
  }

  private mergeTestPeers(players: LobbyPlayer[]): LobbyPlayer[] {
    const realPlayers = players.slice(0, MAX_PLAYERS);
    const testPeers = this.players.filter((player) => player.testPeer);
    return [...realPlayers, ...testPeers].slice(0, MAX_PLAYERS);
  }
}
