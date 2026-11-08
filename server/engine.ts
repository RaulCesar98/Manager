// Motor do jogo no servidor: cria salas, aplica escalações, joga rodadas e
// fecha temporadas. Reaproveita o simulador de sim/ (partida, torcida,
// economia). Tudo aqui é síncrono e trabalha sobre o objeto Room em memória;
// quem chama (server/main.ts) salva a sala depois.

import { computeGate, maintenancePerRound, moodAfterMatch } from '../sim/economy.ts';
import {
  CAMPAIGNS, merchandisingPerRound, updateFans, updateMembers, winBonus,
  type CampaignKind, type SeasonEvent,
} from '../sim/fans.ts';
import { MAX_TICKS, MatchSim, bestCaptain, type MatchOptions } from '../sim/match.ts';
import { Rng } from '../sim/rng.ts';
import {
  DIFFICULTY, MS_PER_MATCH_MINUTE, decideRound, normalizeSettings, updateAfk, validateSettings,
  type HumanSlot, type RoomSettings,
} from '../sim/settings.ts';
import { overall, positionFactor, roleRating } from '../sim/strength.ts';
import { expireContracts, officeAfterRound, seasonStartMessages, sendToClub, type Message, type Negotiation } from './office.ts';
import { marketAfterRound, marketEnv, type HumanOffer, type Listing } from './market.ts';
import { clubAfterRound, clubSeasonStart, gateContext, medicalBonus, type ClubExtra, type Project, type YouthInfo } from './club.ts';
import type { MatchEvent, MatchResult, Position, Staff, TeamSetup } from '../sim/types.ts';
import {
  availableClubs, claimClub, doubleRoundRobin, generateWorld,
  type GenClub, type GenFixture, type GenPlayer, type WorldData,
} from '../sim/worldgen.ts';

// ================================================================= tipos
export const FORMATIONS: Record<string, Position[]> = {
  '4-4-2': ['GOL', 'LAT', 'ZAG', 'ZAG', 'LAT', 'VOL', 'VOL', 'MEI', 'MEI', 'ATA', 'ATA'],
  '4-3-3': ['GOL', 'LAT', 'ZAG', 'ZAG', 'LAT', 'VOL', 'MEI', 'MEI', 'ATA', 'ATA', 'ATA'],
  '4-5-1': ['GOL', 'LAT', 'ZAG', 'ZAG', 'LAT', 'VOL', 'VOL', 'MEI', 'MEI', 'MEI', 'ATA'],
  '3-5-2': ['GOL', 'ZAG', 'ZAG', 'ZAG', 'LAT', 'VOL', 'VOL', 'MEI', 'LAT', 'ATA', 'ATA'],
  '5-3-2': ['GOL', 'LAT', 'ZAG', 'ZAG', 'ZAG', 'LAT', 'VOL', 'MEI', 'MEI', 'ATA', 'ATA'],
};
export type Mentality = -2 | -1 | 0 | 1 | 2;
export const BENCH_SIZE = 7;

export interface Member {
  userId: string; username: string; clubId: number | null;
  missed: number; afk: boolean; joinedAt: number;
}
export interface Tactics { formation: string; lineup: number[]; bench: number[]; mentality: Mentality; captainId?: number }
export interface PlayerStatus {
  injured: number;      // rodadas fora
  suspended: number;    // rodadas suspenso
  yellows: number;      // amarelos acumulados (3 = suspensão)
  goals: number; apps: number; ratingSum: number;
}
export interface ClubSeason {
  pts: number; w: number; d: number; l: number; gf: number; ga: number;
  streak: number; members: number;
  income: Record<string, number>; expense: Record<string, number>;
  lastRound: { income: Record<string, number>; expense: Record<string, number>; fans: { reason: string; fans: number }[] };
  fanHistory: number[];
  campaigns: { kind: CampaignKind; untilRound: number | null }[];
  lastGate?: { rodada: number; adversario: string; publico: number; renda: number; capacidade: number; setores: { setor: string; vendidos: number; procura: number; renda: number }[] };
}
export interface MatchRecord {
  tier: number; round: number; homeId: number; awayId: number; hg: number; ag: number;
  attendance?: number; revenue?: number;
  possessionHome?: number; shotsHome?: number; shotsAway?: number;
  events?: MatchEvent[];
  ratings?: { playerId: number; clubId: number; rating: number; goals: number }[];
}
export interface SeasonSummary {
  season: number;
  tables: { tier: number; name: string; rows: StandingRow[] }[];
  promoted: number[]; relegated: number[]; champions: number[];
}
export interface StandingRow {
  clubId: number; name: string; shortName: string; human: boolean;
  played: number; pts: number; w: number; d: number; l: number; gf: number; ga: number; gd: number;
}

/** Ação do técnico durante a rodada ao vivo (gravada para reconstruir a partida). */
export interface LiveAction {
  tick: number; clubId: number; kind: 'SUB' | 'MENT' | 'AUTO';
  outId?: number; inId?: number; mentality?: Mentality; on?: boolean;
}
/** Rodada acontecendo agora: os jogos avançam conforme o relógio. */
export interface LiveRound { round: number; startedAt: number; msPerTick: number; actions: LiveAction[]; missed: string[] }

export interface Room {
  id: string;
  code: string;               // código de convite
  name: string;
  ownerId: string;
  passwordHash: string | null;
  createdAt: number;
  settings: RoomSettings;
  world: WorldData;
  season: number;
  round: number;              // última rodada jogada na temporada (0 = nenhuma)
  members: Member[];
  ready: string[];            // userIds prontos
  prepStartedAt: number;      // ms; a preparação começa quando a exibição ao vivo termina
  lastRunAt: number | null;
  tactics: Record<number, Tactics>;
  status: Record<number, PlayerStatus>;
  clubs: Record<number, ClubSeason>;
  results: MatchRecord[];     // temporada atual
  lastSeason: SeasonSummary | null;
  history: { season: number; champion: string }[];
  news: { at: number; text: string }[];
  live?: LiveRound | null;
  inbox?: Record<string, Message[]>;   // userId -> mensagens
  negotiations?: Negotiation[];
  msgSeq?: number;
  forSale?: Listing[];           // jogadores à venda (humanos e IA)
  humanOffers?: HumanOffer[];    // propostas entre técnicos humanos
  marketSeeded?: boolean;
  projects?: Project[];                 // obras em andamento
  clubExtra?: Record<number, ClubExtra>; // estado das instalações
  youthInfo?: Record<number, YouthInfo>;
  trainingProgress?: Record<number, Partial<Record<string, number>>>;
}

/** Corrige números quebrados de salas antigas (humor, condição, atributos sempre inteiros). */
export function normalizeRoom(room: Room) {
  for (const c of room.world.clubs) c.fanMood = clamp(Math.round(c.fanMood), 0, 100);
  for (const p of room.world.players) {
    p.fitness = clamp(Math.round(p.fitness), 0, 100);
    p.form = clamp(Math.round(p.form), 0, 100);
    p.morale = clamp(Math.round(p.morale), 0, 100);
    for (const k in p.attrs) p.attrs[k as keyof typeof p.attrs] = clamp(Math.round(p.attrs[k as keyof typeof p.attrs]), 1, 99);
  }
}

// ================================================================ util
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const add = (o: Record<string, number>, k: string, v: number) => { o[k] = (o[k] ?? 0) + v; };

export const clubById = (room: Room, id: number) => room.world.clubs.find((c) => c.id === id)!;
export const squadOf = (room: Room, clubId: number) =>
  room.world.players.filter((p) => p.clubId === clubId && !p.isYouth);
export const humanClubIds = (room: Room) =>
  new Set(room.members.filter((m) => m.clubId !== null).map((m) => m.clubId!));
export const lastRound = (room: Room) => Math.max(...room.world.fixtures.map((f) => f.round));
export const statusOf = (room: Room, playerId: number): PlayerStatus =>
  (room.status[playerId] ??= { injured: 0, suspended: 0, yellows: 0, goals: 0, apps: 0, ratingSum: 0 });
export const isAvailable = (room: Room, p: GenPlayer) => {
  const s = room.status[p.id];
  return !s || (s.injured === 0 && s.suspended === 0);
};

function emptySeason(fanBase: number, members = 0): ClubSeason {
  return {
    pts: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, streak: 0, members,
    income: {}, expense: {}, lastRound: { income: {}, expense: {}, fans: [] },
    fanHistory: [fanBase], campaigns: [],
  };
}

function randomCode(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

// ========================================================= criar sala
export function createRoom(params: {
  id: string; ownerId: string; ownerName: string; settings: RoomSettings;
  passwordHash: string | null; usedCodes: Set<string>;
}): Room {
  const settings = normalizeSettings(params.settings);
  const errors = validateSettings(settings);
  if (errors.length) throw new GameError(errors.join(' '));
  const seed = Math.floor(Math.random() * 2_000_000_000);
  const world = generateWorld(settings, seed);
  let code = randomCode();
  while (params.usedCodes.has(code)) code = randomCode();

  const room: Room = {
    id: params.id, code, name: settings.name, ownerId: params.ownerId,
    passwordHash: settings.isPrivate ? params.passwordHash : null,
    createdAt: Date.now(), settings, world, season: 1, round: 0,
    members: [], ready: [], prepStartedAt: Date.now(), lastRunAt: null,
    tactics: {}, status: {}, clubs: {}, results: [], lastSeason: null, history: [], news: [],
  };
  for (const c of world.clubs) room.clubs[c.id] = emptySeason(c.fanBase);
  joinRoom(room, params.ownerId, params.ownerName);
  news(room, `Sala criada. ${world.clubs.length} clubes em ${world.divisions.length} divisão(ões).`);
  return room;
}

export class GameError extends Error {}

export function news(room: Room, text: string) {
  room.news.unshift({ at: Date.now(), text });
  room.news.length = Math.min(room.news.length, 40);
}

export function joinRoom(room: Room, userId: string, username: string): Member {
  const existing = room.members.find((m) => m.userId === userId);
  if (existing) return existing;
  if (room.members.length >= room.settings.maxHumans) throw new GameError('A sala está cheia.');
  const m: Member = { userId, username, clubId: null, missed: 0, afk: false, joinedAt: Date.now() };
  room.members.push(m);
  return m;
}

export function freeClubs(room: Room): GenClub[] {
  return availableClubs(room.world, humanClubIds(room));
}

/** clubId = null sorteia. Na regra SORTEIO, o clube é sempre sorteado. */
export function pickClub(room: Room, userId: string, clubId: number | null) {
  const m = room.members.find((x) => x.userId === userId);
  if (!m) throw new GameError('Você não está nesta sala.');
  if (m.clubId !== null) throw new GameError('Você já comanda um clube nesta sala.');
  const options = freeClubs(room);
  if (!options.length) throw new GameError('Não há clubes livres.');
  const club = clubId === null || room.settings.structure.humanStart === 'SORTEIO'
    ? options[Math.floor(Math.random() * options.length)]
    : options.find((c) => c.id === clubId);
  if (!club) throw new GameError('Este clube não está disponível.');
  const claimed = claimClub(club, room.settings);
  Object.assign(club, { balance: claimed.balance });
  m.clubId = club.id;
  room.tactics[club.id] = autoTactics(room, club.id, '4-4-2', 0);
  news(room, `${m.username} assumiu o ${club.name}.`);
  sendToClub(room, club.id, { type: 'DIRETORIA', title: `Bem-vindo ao ${club.name}`,
    body: `A diretoria espera uma boa campanha. Por aqui chegam avisos de lesões, humor da torcida, propostas de patrocínio e contratos que precisam ser renovados.` });
  seasonStartMessages(room, club.id);
}

// ============================================================ escalação
/** Melhor escalação possível com os disponíveis (guloso, goleiro primeiro). */
export function autoTactics(room: Room, clubId: number, formation: string, mentality: Mentality): Tactics {
  const roles = FORMATIONS[formation] ?? FORMATIONS['4-4-2'];
  const avail = squadOf(room, clubId).filter((p) => isAvailable(room, p));
  const used = new Set<number>();
  const score = (p: GenPlayer, role: Position) =>
    roleRating(p, role) * positionFactor(p.position, role) * (0.75 + 0.25 * p.fitness / 100);
  // preenche as funções mais "específicas" primeiro
  const order = roles.map((r, i) => ({ r, i })).sort((a, b) => Number(b.r === 'GOL') - Number(a.r === 'GOL'));
  const lineup: number[] = new Array(roles.length).fill(0);
  for (const { r, i } of order) {
    const best = avail.filter((p) => !used.has(p.id)).sort((a, b) => score(b, r) - score(a, r))[0];
    if (best) { lineup[i] = best.id; used.add(best.id); }
  }
  // banco: um goleiro reserva + os melhores restantes
  const rest = avail.filter((p) => !used.has(p.id)).sort((a, b) => overall(b) - overall(a));
  const gk = rest.find((p) => p.position === 'GOL');
  const bench = [...(gk ? [gk] : []), ...rest.filter((p) => p !== gk)].slice(0, BENCH_SIZE).map((p) => p.id);
  const ids = lineup.filter(Boolean);
  const captainId = bestCaptain(avail.filter((p) => ids.includes(p.id)))?.id;
  return { formation: roles === FORMATIONS[formation] ? formation : '4-4-2', lineup: ids, bench, mentality, captainId };
}

/** Valida a escalação enviada pelo usuário. Lança erro com mensagem em português. */
export function setTactics(room: Room, clubId: number, t: Tactics) {
  if (room.live) throw new GameError('A rodada está em andamento. Faça as mudanças pela tela da partida.');
  if (!FORMATIONS[t.formation]) throw new GameError('Formação inválida.');
  if (![-2, -1, 0, 1, 2].includes(t.mentality)) throw new GameError('Mentalidade inválida.');
  if (!Array.isArray(t.lineup) || t.lineup.length !== 11) throw new GameError('Escale 11 titulares.');
  if (!Array.isArray(t.bench) || t.bench.length > BENCH_SIZE) throw new GameError(`No máximo ${BENCH_SIZE} reservas.`);
  const ids = [...t.lineup, ...t.bench];
  if (new Set(ids).size !== ids.length) throw new GameError('Um jogador aparece duas vezes na escalação.');
  const squad = new Map(squadOf(room, clubId).map((p) => [p.id, p]));
  for (const id of ids) {
    const p = squad.get(id);
    if (!p) throw new GameError('Há um jogador que não é do seu elenco.');
    if (!isAvailable(room, p)) {
      const s = room.status[id];
      throw new GameError(`${p.name} está ${s.injured ? 'lesionado' : 'suspenso'}.`);
    }
  }
  if (t.captainId !== undefined && t.captainId !== null && !t.lineup.includes(t.captainId)) throw new GameError('O capitão precisa estar entre os titulares.');
  const captainId = t.captainId ?? bestCaptain(t.lineup.map((id) => squad.get(id)!))?.id;
  room.tactics[clubId] = { formation: t.formation, lineup: [...t.lineup], bench: [...t.bench], mentality: t.mentality, captainId };
}

/** Na hora do jogo: troca quem ficou indisponível e completa o que faltar. */
function effectiveTactics(room: Room, clubId: number): Tactics {
  const saved = room.tactics[clubId];
  if (!saved) return autoTactics(room, clubId, '4-4-2', 0);
  const auto = autoTactics(room, clubId, saved.formation, saved.mentality);
  const roles = FORMATIONS[saved.formation];
  const squad = new Map(squadOf(room, clubId).map((p) => [p.id, p]));
  const ok = (id: number) => squad.has(id) && isAvailable(room, squad.get(id)!);
  const lineup = saved.lineup.map((id) => (ok(id) ? id : 0));
  const used = new Set(lineup.filter(Boolean));
  lineup.forEach((id, i) => {
    if (id) return;
    const role = roles[i];
    const sub = [...squad.values()].filter((p) => ok(p.id) && !used.has(p.id))
      .sort((a, b) => roleRating(b, role) * positionFactor(b.position, role) - roleRating(a, role) * positionFactor(a.position, role))[0];
    if (sub) { lineup[i] = sub.id; used.add(sub.id); }
  });
  const bench = saved.bench.filter((id) => ok(id) && !used.has(id));
  for (const id of auto.bench) if (bench.length < BENCH_SIZE && !used.has(id) && !bench.includes(id)) bench.push(id);
  const ids = lineup.filter(Boolean);
  const captainId = saved.captainId && ids.includes(saved.captainId) ? saved.captainId
    : bestCaptain(ids.map((id) => squad.get(id)!))?.id;
  return { ...saved, lineup: ids, bench, captainId };
}

function staffOf(room: Room, clubId: number): Staff {
  const st = (role: string) => room.world.staff.find((s) => s.clubId === clubId && s.role === role)?.skill ?? 0;
  return {
    coachTactics: st('TECNICO'), coachMotivation: st('TECNICO'), fitnessCoach: st('PREP_FISICO'),
    goalkeeperCoach: st('TREINADOR_GOLEIROS'),
    doctor: Math.min(100, st('MEDICO') + medicalBonus(room, clubId)), physio: Math.min(100, st('FISIOTERAPEUTA') + medicalBonus(room, clubId)),
    youthCoach: st('TREINADOR_BASE'),
  };
}

function buildTeam(room: Room, club: GenClub, isAI: boolean): TeamSetup {
  const t = effectiveTactics(room, club.id);
  const byId = new Map(room.world.players.map((p) => [p.id, p]));
  const roles = FORMATIONS[t.formation];
  return {
    clubId: club.id, name: club.name, mentality: t.mentality, staff: staffOf(room, club.id),
    fanMood: club.fanMood, isAI, captainId: t.captainId,
    lineup: t.lineup.map((id, i) => ({ player: byId.get(id)!, role: roles[i] })),
    bench: t.bench.map((id) => byId.get(id)!),
  };
}

// ============================================================ prontos
export function humanSlots(room: Room): HumanSlot[] {
  return room.members.filter((m) => m.clubId !== null)
    .map((m) => ({ userId: m.userId, ready: room.ready.includes(m.userId), afk: m.afk }));
}

export function setReady(room: Room, userId: string, ready: boolean) {
  const m = room.members.find((x) => x.userId === userId);
  if (!m || m.clubId === null) throw new GameError('Escolha um clube antes.');
  room.ready = room.ready.filter((x) => x !== userId);
  if (ready) room.ready.push(userId);
}

/** Situação da preparação: quem falta, prazo e espera mínima. */
export function readiness(room: Room, now = Date.now()) {
  const humans = humanSlots(room);
  const active = humans.filter((h) => !h.afk || h.ready);
  // A espera mínima conta a partir do fim da rodada anterior. Se todos já clicaram
  // Pronto, ninguém precisa esperar a transmissão ao vivo terminar.
  const minPrepEndsAt = (room.lastRunAt ?? 0) + room.settings.pacing.minPrepSeconds * 1000;
  const allReady = active.length > 0 && active.every((h) => h.ready);
  // O tempo limite só começa depois da transmissão (prepStartedAt).
  const d = decideRound({ now: new Date(now), prepStartedAt: new Date(room.prepStartedAt), humans, settings: room.settings });
  const deadline = room.settings.pacing.prepTimeoutMinutes === null ? null
    : room.prepStartedAt + room.settings.pacing.prepTimeoutMinutes * 60_000;
  return {
    humans, allReady, minPrepEndsAt, deadline,
    waitingFor: active.filter((h) => !h.ready).map((h) => h.userId),
    runNow: (allReady && now >= minPrepEndsAt) || d.run,
    missed: allReady ? [] : d.run ? d.missed : [],
  };
}

/**
 * Chamado pelo timer e a cada acesso: avança a rodada ao vivo, fecha a rodada
 * quando todos os jogos terminam e começa a próxima quando todos estão prontos.
 * Retorna true se algo mudou e a sala precisa ser salva.
 */
export function tick(room: Room, now = Date.now()): boolean {
  if (room.live) {
    const { sims, fixtures } = liveSims(room);
    const t = liveTick(room, now);
    for (const sim of sims) sim.stepTo(t);
    if (!sims.every((x) => x.finished)) return false;
    const live = room.live;
    room.live = null;
    liveCache.delete(room.id);
    applyRoundResults(room, now, live.round, fixtures, sims.map((x) => x.result()), live.missed);
    return true;
  }
  if (!room.members.some((m) => m.clubId !== null)) return false;
  const r = readiness(room, now);
  if (!r.runNow) return false;
  startRound(room, now, r.missed);
  return true;
}

// ============================================================== rodada
export const seasonOver = (room: Room) => room.round >= lastRound(room);

function matchOptions(room: Room): MatchOptions {
  const diff = DIFFICULTY[room.settings.difficulty];
  return { maxSubs: room.settings.rules.maxSubs, injuries: room.settings.rules.injuries, injuryRate: diff.injuryRate, aiStrength: diff.aiStrength };
}
const matchSeed = (room: Room, round: number, f: GenFixture) =>
  (room.world.seed + room.season * 7919 + round * 104729 + f.homeId * 31) % 2_147_483_647;

/** Cria as partidas da rodada a partir das escalações atuais. */
function newSims(room: Room, round: number) {
  const humans = humanClubIds(room);
  const fixtures = room.world.fixtures.filter((x) => x.round === round);
  const opts = matchOptions(room);
  const sims = fixtures.map((f) => new MatchSim(
    buildTeam(room, clubById(room, f.homeId), !humans.has(f.homeId)),
    buildTeam(room, clubById(room, f.awayId), !humans.has(f.awayId)),
    matchSeed(room, round, f), opts));
  return { fixtures, sims };
}

// Partidas ao vivo ficam em memória. Se o servidor reiniciar no meio da rodada,
// elas são reconstruídas: mesma semente + mesmas ações nos mesmos minutos.
const liveCache = new Map<string, { key: string; fixtures: GenFixture[]; sims: MatchSim[] }>();

export function liveSims(room: Room) {
  const live = room.live!;
  const key = `${room.season}:${live.round}:${live.startedAt}`;
  const cached = liveCache.get(room.id);
  if (cached && cached.key === key) return cached;
  const { fixtures, sims } = newSims(room, live.round);
  const simOf = (clubId: number) => sims.find((x, i) => fixtures[i].homeId === clubId || fixtures[i].awayId === clubId);
  for (const a of [...live.actions].sort((x, y) => x.tick - y.tick)) {
    const sim = simOf(a.clubId);
    if (!sim) continue;
    sim.stepTo(a.tick);
    applyAction(sim, a);
  }
  const entry = { key, fixtures, sims };
  liveCache.set(room.id, entry);
  return entry;
}

/** Minutos jogados de acordo com o relógio. */
export function liveTick(room: Room, now = Date.now()): number {
  const live = room.live!;
  return Math.max(0, Math.min(MAX_TICKS, Math.floor((now - live.startedAt) / live.msPerTick)));
}

function applyAction(sim: MatchSim, a: LiveAction): string | null {
  if (a.kind === 'SUB') return sim.substitute(a.clubId, a.outId!, a.inId!);
  if (a.kind === 'MENT') { sim.setMentality(a.clubId, a.mentality!); return null; }
  sim.setAutoSubs(a.clubId, !!a.on);
  return null;
}

/** Substituição, mentalidade ou auxiliar, feitos pelo técnico durante o jogo. */
export function liveAction(room: Room, clubId: number, a: Omit<LiveAction, 'tick' | 'clubId'>, now = Date.now()) {
  if (!room.live) throw new GameError('Não há rodada em andamento.');
  const { sims, fixtures } = liveSims(room);
  const i = fixtures.findIndex((f) => f.homeId === clubId || f.awayId === clubId);
  if (i < 0) throw new GameError('Seu time não joga nesta rodada.');
  const sim = sims[i];
  const t = liveTick(room, now);
  for (const x of sims) x.stepTo(t);
  if (sim.finished) throw new GameError('A partida já terminou.');
  if (a.kind === 'MENT' && ![-2, -1, 0, 1, 2].includes(a.mentality as number)) throw new GameError('Mentalidade inválida.');
  const action: LiveAction = { ...a, tick: sim.t, clubId };
  const err = applyAction(sim, action);
  if (err) throw new GameError(err);
  room.live.actions.push(action);
}

/** Começa a rodada: ao vivo, ou de uma vez se a velocidade for instantânea. */
export function startRound(room: Room, now: number, missed: string[] = []) {
  // A temporada só vira quando todos clicam Pronto depois da última rodada:
  // assim dá para ver a rodada final e a tabela fechada antes.
  if (seasonOver(room)) endSeason(room);
  const round = room.round + 1;
  room.ready = [];
  const ms = MS_PER_MATCH_MINUTE[room.settings.matchSpeed];
  if (!ms) {
    const { fixtures, sims } = newSims(room, round);
    applyRoundResults(room, now, round, fixtures, sims.map((x) => x.runToEnd().result()), missed);
    return;
  }
  room.live = { round, startedAt: now, msPerTick: ms, actions: [], missed };
  liveCache.delete(room.id);
}

/** Joga uma rodada inteira de uma vez (testes e demos). */
export function playRound(room: Room, now: number, missed: string[] = []) {
  if (seasonOver(room)) endSeason(room);
  const round = room.round + 1;
  const { fixtures, sims } = newSims(room, round);
  applyRoundResults(room, now, round, fixtures, sims.map((x) => x.runToEnd().result()), missed);
}

/** Depois dos jogos: tabela, dinheiro, torcida, lesões, suspensões. */
function applyRoundResults(room: Room, now: number, round: number, fixtures: GenFixture[], results: MatchResult[], missed: string[]) {
  const w = room.world;
  const diff = DIFFICULTY[room.settings.difficulty];
  const humans = humanClubIds(room);
  const byId = new Map(w.players.map((p) => [p.id, p]));
  const cityOf = (c: GenClub) => w.cities.find((x) => x.id === c.cityId)!;
  const clubsInCity = (c: GenClub) => w.clubs.filter((x) => x.cityId === c.cityId).length;
  const avgOvr = new Map(w.clubs.map((c) => [c.id,
    squadOf(room, c.id).map(overall).sort((a, b) => b - a).slice(0, 11).reduce((s, x) => s + x, 0) / 11]));
  const played = new Map<number, { res: 'V' | 'E' | 'D'; derby: boolean; occ?: number; price?: number }>();

  for (const cs of Object.values(room.clubs)) cs.lastRound = { income: {}, expense: {}, fans: [] };
  const moodBefore = new Map([...humans].map((id) => [id, clubById(room, id).fanMood]));
  const expensiveTickets = new Set<number>();
  // rodadas antigas perdem os lances (economiza espaço)
  for (const r of room.results) if (r.round < round - 1) { delete r.events; delete r.ratings; }

  fixtures.forEach((f, fi) => {
    const home = clubById(room, f.homeId), away = clubById(room, f.awayId);
    const sh = room.clubs[home.id], sa = room.clubs[away.id];
    const m = results[fi];
    const derby = home.rivalId === away.id || away.rivalId === home.id;

    // bilheteria (mandante)
    const campaignsHome = activeCampaigns(room, home.id, round);
    const gate = computeGate({
      sectors: home.sectors, ...gateContext(room, home.id), fanBase: home.fanBase, fanMood: home.fanMood,
      reputation: home.reputation, opponentReputation: away.reputation, isDerby: derby,
    });
    sh.lastGate = { rodada: round, adversario: away.name, publico: gate.attendance, renda: gate.revenue,
      capacidade: home.sectors.reduce((s, x) => s + x.capacity, 0),
      setores: gate.bySector.map((x) => ({ setor: x.sector, vendidos: x.sold, procura: x.demand, renda: x.revenue })) };
    const ticketIncome = Math.round(campaignsHome.includes('INGRESSO_SOLIDARIO') ? gate.revenue * 0.95 : gate.revenue);
    money(home, sh, 'Bilheteria', ticketIncome);
    home.fanMood = clamp(home.fanMood + gate.moodDelta, 0, 100);
    if (gate.moodDelta < 0) expensiveTickets.add(home.id);
    const cap = home.sectors.reduce((s, x) => s + x.capacity, 0);

    for (const [club, st, gf, ga, isHome] of [[home, sh, m.homeGoals, m.awayGoals, true], [away, sa, m.awayGoals, m.homeGoals, false]] as const) {
      const res = gf > ga ? 'V' : gf === ga ? 'E' : 'D';
      st.gf += gf; st.ga += ga;
      if (res === 'V') { st.w++; st.pts += 3; } else if (res === 'E') { st.d++; st.pts++; } else st.l++;
      const mood = moodAfterMatch({
        goalsFor: gf, goalsAgainst: ga, ourStrength: avgOvr.get(club.id)!,
        theirStrength: avgOvr.get((isHome ? away : home).id)!, isDerby: derby, currentMood: club.fanMood,
      });
      club.fanMood = clamp(club.fanMood + Math.round(mood.delta * (mood.delta < 0 ? diff.fanPatience : 1)), 0, 100);
      played.set(club.id, { res, derby, occ: isHome ? gate.attendance / cap : undefined, price: isHome ? (gate.moodDelta < 0 ? 0.6 : 0) : undefined });
      if (res === 'V') {
        const bonus = w.sponsorships.filter((s) => s.clubId === club.id).reduce((s, x) => s + winBonus(x.perRound), 0);
        money(club, st, 'Patrocínio', bonus);
      }
    }

    // estado dos jogadores
    for (const ps of m.players) {
      const p = byId.get(ps.playerId)!;
      const s = statusOf(room, p.id);
      p.fitness = clamp(ps.fitnessAfter, 0, 100);
      p.form = clamp(Math.round(p.form + (ps.rating - 6) * 8), 0, 100);
      s.apps++; s.goals += ps.goals; s.ratingSum += ps.rating;
      const mine = humans.has(ps.clubId);
      if (ps.injuryRounds) {
        s.injured = Math.max(s.injured, ps.injuryRounds + 1); // +1: a rodada atual conta
        if (mine) sendToClub(room, ps.clubId, { type: 'LESAO', playerId: p.id, title: `Lesão: ${p.name}`,
          body: `${p.name} (${p.position}) se machucou na rodada ${round} e deve ficar fora por ${ps.injuryRounds} rodada${ps.injuryRounds > 1 ? 's' : ''}.` });
      }
      if (ps.red) {
        s.suspended = 2;
        if (mine) sendToClub(room, ps.clubId, { type: 'SUSPENSAO', playerId: p.id, title: `Suspensão: ${p.name}`, body: `${p.name} foi expulso e não joga a próxima rodada.` });
      } else if (ps.yellow) {
        s.yellows += ps.yellow;
        if (s.yellows >= 3) {
          s.suspended = 2; s.yellows = 0;
          if (mine) sendToClub(room, ps.clubId, { type: 'SUSPENSAO', playerId: p.id, title: `Suspensão: ${p.name}`, body: `${p.name} recebeu o 3º cartão amarelo e cumpre suspensão na próxima rodada.` });
        }
      }
    }

    room.results.push({
      tier: f.tier, round, homeId: home.id, awayId: away.id, hg: m.homeGoals, ag: m.awayGoals,
      attendance: gate.attendance, revenue: ticketIncome,
      possessionHome: m.stats.possessionHome, shotsHome: m.stats.shotsHome, shotsAway: m.stats.shotsAway,
      events: m.events,
      ratings: m.players.map((p) => ({ playerId: p.playerId, clubId: p.clubId, rating: p.rating, goals: p.goals })),
    });
  });

  // receitas, despesas e torcida de todos os clubes
  for (const club of w.clubs) {
    const st = room.clubs[club.id];
    const p = played.get(club.id);
    const campaigns = activeCampaigns(room, club.id, round);
    const sponsor = w.sponsorships.filter((s) => s.clubId === club.id).reduce((s, x) => s + x.perRound, 0);
    money(club, st, 'Patrocínio', sponsor);
    const mem = updateMembers({ members: st.members, fanBase: club.fanBase, fanMood: club.fanMood, monthlyPrice: club.membershipPrice, reputation: club.reputation });
    st.members = mem.members;
    money(club, st, 'Sócio-torcedor', mem.revenuePerRound);
    money(club, st, 'Produtos', merchandisingPerRound(club.fanBase, club.reputation, club.fanMood));
    const wages = squadOf(room, club.id).reduce((s, x) => s + x.weeklySalary, 0)
      + w.players.filter((x) => x.clubId === club.id && x.isYouth).reduce((s, x) => s + x.weeklySalary, 0)
      + w.staff.filter((s) => s.clubId === club.id).reduce((s, x) => s + x.weeklySalary, 0);
    money(club, st, 'Salários', -wages);
    const maint = Object.values(club.facilities).reduce((s, lvl) => s + maintenancePerRound(lvl), 0);
    money(club, st, 'Manutenção', -maint);
    for (const c of campaigns) {
      money(club, st, 'Marketing', -CAMPAIGNS[c].costPerRound(club.fanBase));
      // bônus fracionário vira +1 com essa probabilidade (o humor é sempre inteiro)
      if (Math.random() < CAMPAIGNS[c].moodBonus) club.fanMood = clamp(club.fanMood + 1, 0, 100);
    }

    const fans = updateFans({
      fanBase: club.fanBase, fanMood: club.fanMood,
      market: { cityPopulation: cityOf(club).population, clubsInCity: clubsInCity(club), reputation: club.reputation },
      result: p?.res, isDerby: p?.derby, winStreak: st.streak, homeOccupancy: p?.occ, ticketPriceScore: p?.price,
      activeCampaigns: campaigns, idolsPopularity: squadOf(room, club.id).map((x) => x.popularity),
      homegrownStarters: 0, difficulty: diff,
    });
    club.fanBase = fans.newFanBase;
    st.lastRound.fans = fans.breakdown;
    st.fanHistory.push(club.fanBase);
    st.streak = p?.res === 'V' ? st.streak + 1 : p ? 0 : st.streak;
    st.campaigns = st.campaigns.filter((c) => c.untilRound === null || c.untilRound > round);
  }

  // recuperação para a próxima rodada
  for (const p of w.players) {
    const s = room.status[p.id];
    if (s) { if (s.injured) s.injured--; if (s.suspended) s.suspended--; }
    if (p.clubId === null) continue;
    const prep = staffOf(room, p.clubId).fitnessCoach;
    p.fitness = clamp(Math.round(p.fitness + 24 + prep / 10), 0, 100);
    p.form = Math.round(p.form + (50 - p.form) * 0.1);
  }

  room.round = round;
  room.lastRunAt = now;

  // humor da torcida: avisa quando cruza uma faixa
  for (const id of humans) {
    const before = moodBefore.get(id)!, after = clubById(room, id).fanMood;
    const recent = room.results.filter((r) => r.homeId === id || r.awayId === id).slice(-3)
      .map((r) => { const gf = r.homeId === id ? r.hg : r.ag, ga = r.homeId === id ? r.ag : r.hg; return gf > ga ? 'V' : gf === ga ? 'E' : 'D'; });
    const why = [recent.length ? `últimos jogos: ${recent.join('-')}` : '', expensiveTickets.has(id) ? 'reclamações do preço do ingresso' : ''].filter(Boolean).join('; ');
    if (before >= 25 && after < 25) sendToClub(room, id, { type: 'TORCIDA', title: 'Protesto da torcida', body: `Torcedores protestaram na porta do clube (humor ${after}). Público e sócios devem cair. Motivos: ${why}.` });
    else if (before >= 40 && after < 40) sendToClub(room, id, { type: 'TORCIDA', title: 'Torcida insatisfeita', body: `O humor da torcida caiu para ${after}. Motivos: ${why}. Bons resultados ou ações de marketing ajudam a recuperar.` });
    else if (before < 80 && after >= 80) sendToClub(room, id, { type: 'TORCIDA', title: 'Torcida empolgada', body: `O humor chegou a ${after}. Bom momento para lotar o estádio e vender sócios.` });
  }
  officeAfterRound(room);
  marketAfterRound(room);
  clubAfterRound(room);
  // AFK e prontos
  const slots = humanSlots(room);
  const counts = new Map(room.members.map((m) => [m.userId, m.missed]));
  const { nowAfk, back } = updateAfk(counts, slots, missed, room.settings);
  for (const m of room.members) {
    m.missed = counts.get(m.userId) ?? 0;
    if (nowAfk.includes(m.userId)) { m.afk = true; news(room, `${m.username} perdeu ${m.missed} prazos seguidos e ficou ausente (AFK).`); }
    if (back.includes(m.userId)) m.afk = false;
  }
  room.ready = [];
  room.prepStartedAt = now;   // a rodada já foi assistida ao vivo; o tempo limite começa agora

  // um jogo entre dois humanos gera só uma notícia
  for (const r of room.results.filter((x) => x.round === round && (humans.has(x.homeId) || humans.has(x.awayId)))) {
    news(room, `Rodada ${round}: ${clubById(room, r.homeId).name} ${r.hg} × ${r.ag} ${clubById(room, r.awayId).name}`);
  }
}

function money(club: GenClub, st: ClubSeason, label: string, amount: number) {
  if (!amount) return;
  club.balance += amount;
  if (amount > 0) { add(st.income, label, amount); add(st.lastRound.income, label, amount); }
  else { add(st.expense, label, -amount); add(st.lastRound.expense, label, -amount); }
}

// =========================================================== torcida
export function activeCampaigns(room: Room, clubId: number, round: number): CampaignKind[] {
  return room.clubs[clubId].campaigns
    .filter((c) => c.untilRound === null || c.untilRound >= round).map((c) => c.kind);
}

export function startCampaign(room: Room, clubId: number, kind: CampaignKind) {
  const def = CAMPAIGNS[kind];
  if (!def) throw new GameError('Campanha inválida.');
  const st = room.clubs[clubId];
  if (st.campaigns.some((c) => c.kind === kind)) throw new GameError('Essa campanha já está ativa.');
  const club = clubById(room, clubId);
  const cost = def.costPerRound(club.fanBase);
  if (room.settings.rules.blockSpendingWhenNegative && club.balance < cost)
    throw new GameError('Caixa insuficiente para começar essa campanha.');
  const next = room.round + 1;
  st.campaigns.push({ kind, untilRound: def.durationRounds === null ? null : next + def.durationRounds - 1 });
}

export function stopCampaign(room: Room, clubId: number, kind: CampaignKind) {
  const st = room.clubs[clubId];
  st.campaigns = st.campaigns.filter((c) => c.kind !== kind);
}

// =========================================================== tabela
export function standings(room: Room, tier: number): StandingRow[] {
  const humans = humanClubIds(room);
  return room.world.clubs.filter((c) => c.tier === tier).map((c) => {
    const s = room.clubs[c.id];
    return {
      clubId: c.id, name: c.name, shortName: c.shortName, human: humans.has(c.id),
      played: s.w + s.d + s.l, pts: s.pts, w: s.w, d: s.d, l: s.l, gf: s.gf, ga: s.ga, gd: s.gf - s.ga,
    };
  }).sort((a, b) => b.pts - a.pts || b.w - a.w || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name));
}

// ==================================================== fim de temporada
function endSeason(room: Room) {
  const w = room.world;
  const diff = DIFFICULTY[room.settings.difficulty];
  const { promotion, relegation, divisions } = room.settings.structure;
  const summary: SeasonSummary = { season: room.season, tables: [], promoted: [], relegated: [], champions: [] };
  const tierChange = new Map<number, number>();

  for (let t = 1; t <= divisions; t++) {
    const rows = standings(room, t);
    summary.tables.push({ tier: t, name: w.divisions.find((d) => d.tier === t)?.name ?? `Divisão ${t}`, rows });
    summary.champions.push(rows[0].clubId);
    rows.forEach((row, pos) => {
      const ev: SeasonEvent[] = [];
      if (pos === 0 && t === 1) ev.push('TITULO_LIGA');
      if (t > 1 && pos < promotion) { ev.push('ACESSO'); tierChange.set(row.clubId, t - 1); summary.promoted.push(row.clubId); }
      if (t < divisions && pos >= rows.length - relegation) { ev.push('REBAIXAMENTO'); tierChange.set(row.clubId, t + 1); summary.relegated.push(row.clubId); }
      if (!ev.length) return;
      const club = clubById(room, row.clubId);
      const r = updateFans({
        fanBase: club.fanBase, fanMood: club.fanMood,
        market: { cityPopulation: w.cities.find((c) => c.id === club.cityId)!.population, clubsInCity: w.clubs.filter((x) => x.cityId === club.cityId).length, reputation: club.reputation },
        winStreak: 0, activeCampaigns: [], idolsPopularity: [], homegrownStarters: 0, seasonEvents: ev, difficulty: diff,
      });
      club.fanBase = r.newFanBase;
      if (ev.includes('TITULO_LIGA')) club.reputation = clamp(club.reputation + 4, 1, 100);
      if (ev.includes('ACESSO')) club.reputation = clamp(club.reputation + 2, 1, 100);
      if (ev.includes('REBAIXAMENTO')) club.reputation = clamp(club.reputation - 3, 1, 100);
    });
  }

  const champ = clubById(room, summary.champions[0]);
  room.history.push({ season: room.season, champion: champ.name });
  news(room, `Fim da temporada ${room.season}! ${champ.name} é campeão da ${summary.tables[0].name}.`);
  const humans = humanClubIds(room);
  for (const id of humans) {
    if (summary.promoted.includes(id)) news(room, `${clubById(room, id).name} conquistou o acesso!`);
    if (summary.relegated.includes(id)) news(room, `${clubById(room, id).name} foi rebaixado.`);
  }

  // nova temporada
  for (const [id, tier] of tierChange) clubById(room, id).tier = tier;
  room.lastSeason = summary;
  room.season++;
  room.round = 0;
  const rng = new Rng(w.seed + room.season * 7919);
  w.fixtures = [];
  for (let t = 1; t <= divisions; t++) w.fixtures.push(...doubleRoundRobin(w.clubs.filter((c) => c.tier === t).map((c) => c.id), t, rng));
  for (const c of w.clubs) {
    const old = room.clubs[c.id];
    room.clubs[c.id] = { ...emptySeason(c.fanBase, old.members), campaigns: old.campaigns.filter((x) => x.untilRound === null) };
  }
  for (const p of w.players) { p.age++; p.fitness = 100; }
  for (const s of Object.values(room.status)) { s.yellows = 0; s.suspended = 0; s.goals = 0; s.apps = 0; s.ratingSum = 0; }
  room.results = [];
  expireContracts(room);
  if (room.settings.rules.youthIntakePerSeason) clubSeasonStart(room);
  // quem saiu do elenco não pode continuar na escalação salva
  for (const m of room.members) if (m.clubId !== null) {
    const t = room.tactics[m.clubId];
    if (t) room.tactics[m.clubId] = effectiveTactics(room, m.clubId);
  }
}

// o mercado usa estas funções do motor (registradas aqui para evitar import circular)
marketEnv.repairTactics = (room, clubId) => {
  if (room.tactics[clubId]) room.tactics[clubId] = effectiveTactics(room, clubId);
};
marketEnv.news = news;
