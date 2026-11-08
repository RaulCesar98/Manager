// Motor de partida minuto a minuto.
//
// MatchSim guarda o estado da partida e avança um minuto por vez (step).
// Isso permite jogar ao vivo: o servidor avança conforme o relógio e o
// técnico pode substituir ou mudar a mentalidade no meio do jogo.
//
// Determinístico: mesma entrada + mesma semente + mesmas ações nos mesmos
// minutos = mesmo resultado. Por isso o servidor só precisa guardar as ações
// (substituições) para reconstruir uma partida em andamento.
//
// simulateMatch() continua existindo: joga a partida inteira de uma vez.

import { Rng } from './rng.ts';
import { sectorStrength } from './strength.ts';
import type {
  LineupSlot, MatchEvent, MatchResult, Player, PlayerMatchState, Position, TeamSetup,
} from './types.ts';

// --- Constantes de calibragem (ajuste testando milhares de jogos) -------
const SHOT_BASE = 0.29;        // chance de finalização por minuto com a posse
const GOAL_BASE = 0.105;       // conversão base de uma finalização
const FOUL_CARD = 0.017;       // chance de cartão por minuto (time sem a bola)
const INJURY_BASE = 0.00022;   // por jogador por minuto
export const MAX_TICKS = 99;   // 90 + até 3 de acréscimo no 1º tempo + até 6 no 2º

/** Regras da sala que afetam a partida (vêm de RoomSettings + dificuldade). */
export interface MatchOptions {
  maxSubs?: number;          // 3 ou 5
  injuries?: boolean;        // false desliga lesões
  injuryRate?: number;       // multiplicador (dificuldade)
  aiStrength?: number;       // multiplicador de força dos clubes da IA (dificuldade)
}

const SHOOTER_WEIGHT: Record<Position, number> = {
  GOL: 0, ZAG: 0.45, LAT: 0.6, VOL: 0.9, MEI: 2.3, ATA: 5,
};

interface Side {
  team: TeamSetup;           // cópia: mentalidade pode mudar no jogo
  isHome: boolean;
  onPitch: LineupSlot[];
  bench: Player[];
  subsUsed: number;
  goals: number;
  shots: number;
  possessionMinutes: number;
  autoSubs: boolean;         // auxiliar faz trocas por cansaço
  captainId: number | null;  // quem está com a faixa agora
}

/**
 * Liderança de 0 a 1: experiência (idade) e popularidade no elenco.
 * O capitão em campo dá até +3% de força ao time.
 */
export function leadership(p: Player): number {
  return Math.max(0, Math.min(1, (p.age - 20) / 12)) * 0.6 + (p.popularity / 100) * 0.4;
}
export const CAPTAIN_MAX_BONUS = 0.03;
/** Capitão automático: o maior líder entre os titulares. */
export function bestCaptain(players: Player[]): Player | undefined {
  return [...players].sort((a, b) => leadership(b) - leadership(a))[0];
}

/** O que o técnico vê do próprio time durante o jogo. */
export interface LiveTeamView {
  clubId: number;
  mentality: number;
  autoSubs: boolean;
  subsUsed: number;
  maxSubs: number;
  captainId: number | null;
  onPitch: { id: number; name: string; role: Position; position: Position; fitness: number; yellow: number; goals: number }[];
  bench: { id: number; name: string; position: Position; fitness: number }[];
  out: { id: number; name: string; reason: 'SUBSTITUIDO' | 'EXPULSO' | 'LESIONADO' }[];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export class MatchSim {
  readonly home: Side;
  readonly away: Side;
  readonly events: MatchEvent[] = [];
  readonly totalMinutes: number;
  /** minutos já jogados (0 = não começou) */
  t = 0;
  private readonly stoppage1: number;
  private readonly rng: Rng;
  private readonly maxSubs: number;
  private readonly injuryBase: number;
  private readonly aiMul: number;
  private readonly fitness = new Map<number, number>();
  private readonly states = new Map<number, PlayerMatchState>();
  private readonly gone: LiveTeamView['out'][] = [[], []];

  constructor(home: TeamSetup, away: TeamSetup, seed: number, opts: MatchOptions = {}) {
    this.maxSubs = opts.maxSubs ?? 5;
    this.injuryBase = opts.injuries === false ? 0 : INJURY_BASE * (opts.injuryRate ?? 1);
    this.aiMul = opts.aiStrength ?? 1;
    this.rng = new Rng(seed);
    this.home = this.makeSide(home, true);
    this.away = this.makeSide(away, false);
    this.stoppage1 = this.rng.int(0, 3);
    const stoppage2 = this.rng.int(2, 6);
    this.totalMinutes = 90 + this.stoppage1 + stoppage2;
  }

  get finished() { return this.t >= this.totalMinutes; }

  /** Minuto "de exibição" depois de t minutos jogados (45+2 aparece como 45, 90+4 como 90). */
  displayMinute(t = this.t): number {
    return t <= 45 + this.stoppage1 ? Math.min(t, 45) : Math.min(t - this.stoppage1, 90);
  }
  /** Texto do relógio: 12', 45+2', Intervalo, 90+3', Fim. */
  clock(t = this.t): string {
    if (t >= this.totalMinutes) return 'Fim';
    if (t <= 45) return `${t}'`;
    if (t <= 45 + this.stoppage1) return `45+${t - 45}'`;
    const m = t - this.stoppage1;
    return m <= 90 ? `${m}'` : `90+${m - 90}'`;
  }
  get isHalftime() { return this.t === 45 + this.stoppage1; }

  /** Avança até `t` minutos jogados (ou o fim). */
  stepTo(t: number) { while (this.t < Math.min(t, this.totalMinutes)) this.step(); }
  runToEnd() { this.stepTo(this.totalMinutes); return this; }

  private sideOf(clubId: number): Side | undefined {
    return this.home.team.clubId === clubId ? this.home : this.away.team.clubId === clubId ? this.away : undefined;
  }

  // ------------------------------------------------- ações do técnico
  /** Substituição feita pelo técnico. Retorna mensagem de erro ou null. */
  substitute(clubId: number, outId: number, inId: number): string | null {
    const side = this.sideOf(clubId);
    if (!side) return 'Este time não está nesta partida.';
    if (this.finished) return 'A partida já terminou.';
    if (side.subsUsed >= this.maxSubs) return `Você já fez as ${this.maxSubs} substituições.`;
    const out = side.onPitch.find((s) => s.player.id === outId);
    if (!out) return 'Esse jogador não está em campo.';
    const incoming = side.bench.find((p) => p.id === inId);
    if (!incoming) return 'Esse jogador não está no banco.';
    this.swap(side, out, incoming, this.displayMinute(), 'SUBSTITUIDO');
    return null;
  }
  setMentality(clubId: number, mentality: TeamSetup['mentality']) {
    const side = this.sideOf(clubId);
    if (side) side.team.mentality = mentality;
  }
  setAutoSubs(clubId: number, on: boolean) {
    const side = this.sideOf(clubId);
    if (side) side.autoSubs = on;
  }

  /** Visão do time para a tela de substituição. */
  teamView(clubId: number): LiveTeamView | null {
    const side = this.sideOf(clubId);
    if (!side) return null;
    const st = (id: number) => this.states.get(id)!;
    return {
      clubId, mentality: side.team.mentality, autoSubs: side.autoSubs, subsUsed: side.subsUsed, maxSubs: this.maxSubs, captainId: side.captainId,
      onPitch: side.onPitch.map((s) => ({
        id: s.player.id, name: s.player.name, role: s.role, position: s.player.position,
        fitness: Math.round(this.fitness.get(s.player.id)!), yellow: st(s.player.id).yellow, goals: st(s.player.id).goals,
      })),
      bench: side.bench.map((p) => ({ id: p.id, name: p.name, position: p.position, fitness: Math.round(p.fitness) })),
      out: this.gone[side.isHome ? 0 : 1],
    };
  }

  get score() { return { home: this.home.goals, away: this.away.goals }; }

  // ------------------------------------------------------- um minuto
  step() {
    if (this.finished) return;
    const t = ++this.t;
    const { rng, home: H, away: A } = this;
    const minute = this.displayMinute(t);
    if (t === 46 + this.stoppage1) this.events.push({ minute: 45, type: 'INTERVALO', text: `Intervalo: ${H.team.name} ${H.goals} x ${A.goals} ${A.team.name}` });

    const sH = this.scale(H.team, sectorStrength(H.team, H.onPitch, this.fitness, true));
    const sA = this.scale(A.team, sectorStrength(A.team, A.onPitch, this.fitness, false));

    // 1) Quem tem a bola neste minuto? Disputa no meio-campo.
    const k = 1.9;
    const pHome = sH.mid ** k / (sH.mid ** k + sA.mid ** k);
    const [atk, def, sAtk, sDef] = rng.chance(pHome) ? [H, A, sH, sA] : [A, H, sA, sH];
    atk.possessionMinutes++;

    // 2) Sai finalização? Ataque de quem tem a bola vs defesa adversária.
    const ratio = sAtk.att / Math.max(1, sDef.def);
    const mentalityBoost = 1 + 0.08 * atk.team.mentality;
    if (rng.chance(clamp(SHOT_BASE * ratio ** 1.15 * mentalityBoost, 0.04, 0.6))) {
      atk.shots++;
      const shooter = rng.weighted(atk.onPitch, (s) =>
        SHOOTER_WEIGHT[s.role] * (s.player.attrs.finishing + s.player.attrs.heading * 0.3));
      const finishing = shooter.player.attrs.finishing * (0.6 + 0.4 * (this.fitness.get(shooter.player.id)! / 100));
      const pGoal = clamp(GOAL_BASE * (finishing / Math.max(10, sDef.gk)) ** 1.2 * ratio ** 0.4, 0.02, 0.55);
      const st = this.states.get(shooter.player.id)!;
      const gkSlot = def.onPitch.find((s) => s.role === 'GOL');

      if (rng.chance(pGoal)) {
        atk.goals++;
        st.goals++;
        st.rating += 1.0;
        this.events.push({
          minute, type: 'GOL', clubId: atk.team.clubId, playerId: shooter.player.id,
          text: `GOL! ${shooter.player.name} marca para o ${atk.team.name}. ${H.team.name} ${H.goals} x ${A.goals} ${A.team.name}`,
        });
        for (const s of def.onPitch) if (s.role !== 'MEI' && s.role !== 'ATA') this.states.get(s.player.id)!.rating -= 0.25;
      } else if (gkSlot && rng.chance(0.45)) {
        this.states.get(gkSlot.player.id)!.rating += 0.2;
        this.events.push({ minute, type: 'DEFESA', clubId: def.team.clubId, playerId: gkSlot.player.id,
          text: `${gkSlot.player.name} faz boa defesa no chute de ${shooter.player.name}.` });
      } else if (rng.chance(0.3)) {
        this.events.push({ minute, type: 'CHANCE', clubId: atk.team.clubId, playerId: shooter.player.id,
          text: `${shooter.player.name} finaliza para fora.` });
      }
    }

    // 3) Cartões (para o time que está defendendo)
    if (rng.chance(FOUL_CARD)) {
      const fouler = rng.weighted(def.onPitch, (s) => (s.role === 'GOL' ? 0.1 : s.player.attrs.strength * (s.role === 'ZAG' || s.role === 'VOL' ? 1.5 : 1)));
      const st = this.states.get(fouler.player.id)!;
      const straightRed = rng.chance(0.04);
      if (straightRed || st.yellow === 1) {
        st.red = true;
        st.rating -= 1.5;
        def.onPitch = def.onPitch.filter((s) => s !== fouler);
        this.gone[def.isHome ? 0 : 1].push({ id: fouler.player.id, name: fouler.player.name, reason: 'EXPULSO' });
        this.passArmband(def, minute);
        this.events.push({ minute, type: 'VERMELHO', clubId: def.team.clubId, playerId: fouler.player.id,
          text: `Expulso! ${fouler.player.name} recebe o vermelho.` });
        if (fouler.role === 'GOL') this.emergencyKeeper(def, minute);
      } else {
        st.yellow++;
        st.rating -= 0.2;
        this.events.push({ minute, type: 'AMARELO', clubId: def.team.clubId, playerId: fouler.player.id,
          text: `Cartão amarelo para ${fouler.player.name}.` });
      }
    }

    // 4) Cansaço e lesões
    for (const side of [H, A]) {
      const prep = side.team.staff.fitnessCoach;
      for (const s of [...side.onPitch]) {
        const id = s.player.id;
        const drain = (0.2 - s.player.attrs.stamina * 0.0011) * (1 - prep / 400) * (s.role === 'GOL' ? 0.3 : 1);
        this.fitness.set(id, Math.max(0, this.fitness.get(id)! - drain));
        this.states.get(id)!.minutesPlayed++;

        const tired = 1 + (100 - this.fitness.get(id)!) / 40;
        const physio = 1 - side.team.staff.physio / 250;
        if (rng.chance(this.injuryBase * tired * physio)) {
          // médico bom reduz o tempo de recuperação
          const rounds = Math.max(1, Math.round(rng.int(1, 8) * (1 - side.team.staff.doctor / 200)));
          this.states.get(id)!.injuryRounds = rounds;
          this.events.push({ minute, type: 'LESAO', clubId: side.team.clubId, playerId: id,
            text: `${s.player.name} sente lesão e deve desfalcar o time por ${rounds} rodada(s).` });
          this.autoSubstitute(side, s, minute, true);
        }
      }
    }

    // 5) Substituições por cansaço (auxiliar técnico; pode ser desligado pelo técnico humano)
    if (minute >= 58 && minute <= 85 && t % 4 === 0) {
      for (const side of [H, A]) {
        if (!side.autoSubs || side.subsUsed >= this.maxSubs || side.bench.length === 0) continue;
        const tiredest = side.onPitch
          .filter((s) => s.role !== 'GOL')
          .sort((a, b) => this.fitness.get(a.player.id)! - this.fitness.get(b.player.id)!)[0];
        if (tiredest && this.fitness.get(tiredest.player.id)! < 62) this.autoSubstitute(side, tiredest, minute, false);
      }
    }

    if (t === this.totalMinutes)
      this.events.push({ minute: 90, type: 'FIM', text: `Fim de jogo: ${H.team.name} ${H.goals} x ${A.goals} ${A.team.name}` });
  }

  /** Resultado final (chame depois de terminar; pode ser chamado mais de uma vez). */
  result(): MatchResult {
    const H = this.home, A = this.away;
    const diff = H.goals - A.goals;
    const players = [...this.states.values()].map((s0) => {
      const st = { ...s0 };
      const won = st.clubId === H.team.clubId ? diff > 0 : diff < 0;
      const lost = st.clubId === H.team.clubId ? diff < 0 : diff > 0;
      if (won) st.rating += 0.4;
      if (lost) st.rating -= 0.3;
      if (st.minutesPlayed < 15) st.rating = 6.0 + (st.rating - 6.0) * 0.5;
      st.rating = Math.round(clamp(st.rating, 3, 10) * 10) / 10;
      st.fitnessAfter = Math.round(this.fitness.get(st.playerId)!);
      return st;
    });
    return {
      homeGoals: H.goals,
      awayGoals: A.goals,
      events: [...this.events],
      players,
      stats: {
        possessionHome: Math.round((100 * H.possessionMinutes) / Math.max(1, H.possessionMinutes + A.possessionMinutes)),
        shotsHome: H.shots,
        shotsAway: A.shots,
      },
    };
  }

  // ------------------------------------------------------- internos
  private makeSide(team: TeamSetup, isHome: boolean): Side {
    const copy: TeamSetup = { ...team };
    for (const s of team.lineup) this.register(s.player, team.clubId);
    return {
      captainId: team.captainId && team.lineup.some((s) => s.player.id === team.captainId) ? team.captainId
        : bestCaptain(team.lineup.map((s) => s.player))?.id ?? null,
      team: copy, isHome, onPitch: [...team.lineup], bench: [...team.bench],
      subsUsed: 0, goals: 0, shots: 0, possessionMinutes: 0, autoSubs: team.autoSubs ?? true,
    };
  }
  private register(p: Player, clubId: number) {
    this.fitness.set(p.id, p.fitness);
    this.states.set(p.id, {
      playerId: p.id, clubId, minutesPlayed: 0, fitnessAfter: p.fitness,
      goals: 0, yellow: 0, red: false, injuryRounds: 0, rating: 6.0,
    });
  }
  private scale(t: TeamSetup, s: ReturnType<typeof sectorStrength>) {
    const side = t.clubId === this.home.team.clubId ? this.home : this.away;
    const cap = side.onPitch.find((x) => x.player.id === side.captainId);
    const mul = (t.isAI ? this.aiMul : 1) * (cap ? 1 + CAPTAIN_MAX_BONUS * leadership(cap.player) : 1);
    return mul !== 1 ? { gk: s.gk * mul, def: s.def * mul, mid: s.mid * mul, att: s.att * mul } : s;
  }
  /** Se o capitão saiu (substituído, expulso, lesionado), a faixa passa para o maior líder em campo. */
  private passArmband(side: Side, minute: number) {
    if (side.onPitch.some((x) => x.player.id === side.captainId)) return;
    const next = bestCaptain(side.onPitch.map((x) => x.player));
    side.captainId = next?.id ?? null;
    if (next) this.events.push({ minute, type: 'SUBSTITUICAO', clubId: side.team.clubId, playerId: next.id, text: `${next.name} assume a faixa de capitão do ${side.team.name}.` });
  }
  private swap(side: Side, out: LineupSlot, incoming: Player, minute: number, reason: 'SUBSTITUIDO' | 'LESIONADO') {
    const idx = side.onPitch.indexOf(out);
    side.bench = side.bench.filter((p) => p !== incoming);
    this.register(incoming, side.team.clubId);
    side.onPitch[idx] = { player: incoming, role: out.role };
    side.subsUsed++;
    this.gone[side.isHome ? 0 : 1].push({ id: out.player.id, name: out.player.name, reason });
    this.events.push({ minute, type: 'SUBSTITUICAO', clubId: side.team.clubId, playerId: incoming.id,
      text: `Substituição no ${side.team.name}: sai ${out.player.name}, entra ${incoming.name}.` });
    this.passArmband(side, minute);
  }
  private autoSubstitute(side: Side, out: LineupSlot, minute: number, forced: boolean) {
    const idx = side.onPitch.indexOf(out);
    if (idx < 0) return;
    if (side.subsUsed >= this.maxSubs || side.bench.length === 0) {
      if (forced) {   // lesionado sai e o time fica com um a menos
        side.onPitch.splice(idx, 1);
        this.gone[side.isHome ? 0 : 1].push({ id: out.player.id, name: out.player.name, reason: 'LESIONADO' });
        this.passArmband(side, minute);
      }
      return;
    }
    // prefere reserva da mesma posição; entre eles, o mais descansado
    const sameRole = side.bench.filter((p) => p.position === out.role);
    const pool = sameRole.length ? sameRole : side.bench;
    const incoming = pool.reduce((best, p) => (p.fitness > best.fitness ? p : best), pool[0]);
    this.swap(side, out, incoming, minute, forced ? 'LESIONADO' : 'SUBSTITUIDO');
  }
  private emergencyKeeper(side: Side, minute: number) {
    const benchGk = side.bench.find((p) => p.position === 'GOL');
    if (benchGk && side.subsUsed < this.maxSubs) {
      // tira um jogador de linha para colocar o goleiro reserva
      const outIdx = side.onPitch.findIndex((s) => s.role === 'ATA' || s.role === 'MEI');
      if (outIdx >= 0) {
        const out = side.onPitch[outIdx];
        side.onPitch.splice(outIdx, 1);
        side.bench = side.bench.filter((p) => p !== benchGk);
        this.register(benchGk, side.team.clubId);
        side.onPitch.push({ player: benchGk, role: 'GOL' });
        side.subsUsed++;
        this.gone[side.isHome ? 0 : 1].push({ id: out.player.id, name: out.player.name, reason: 'SUBSTITUIDO' });
        this.events.push({ minute, type: 'SUBSTITUICAO', clubId: side.team.clubId, playerId: benchGk.id,
          text: `${side.team.name} sacrifica ${out.player.name} para a entrada do goleiro ${benchGk.name}.` });
        return;
      }
    }
    // sem goleiro reserva: um jogador de linha vai para o gol
    const s = side.onPitch.find((x) => x.role === 'ZAG') ?? side.onPitch[0];
    if (s) s.role = 'GOL';
  }
}

/** Joga a partida inteira de uma vez. */
export function simulateMatch(home: TeamSetup, away: TeamSetup, seed: number, opts: MatchOptions = {}): MatchResult {
  return new MatchSim(home, away, seed, opts).runToEnd().result();
}
