// Estrutura do clube: estádio (ingressos, ampliação, reforma), instalações
// (CT, base, departamento médico), divisão de base e evolução semanal dos
// jogadores pelo treino.
//
// Instalações têm nível (1 a 10) e estado de conservação (0 a 100%). O estado
// cai um pouco a cada rodada; reforma recupera. Obras custam dinheiro (pago em
// parcelas a cada rodada), levam rodadas e, no estádio, fecham lugares.

import { computeGate, referencePrice, type Sector } from '../sim/economy.ts';
import { Rng } from '../sim/rng.ts';
import { DIFFICULTY } from '../sim/settings.ts';
import { overall } from '../sim/strength.ts';
import { applyTraining, type TrainingFocus } from '../sim/training.ts';
import { ATTRIBUTES, type Attribute } from '../sim/types.ts';
import { salaryFor, type GenClub, type GenPlayer } from '../sim/worldgen.ts';
import { FIRST, LAST, generateYouthIntake } from '../sim/youth.ts';
import { marketValue } from '../sim/economy.ts';
import type { Room } from './engine.ts';
import { OfficeError, brl, sendToClub } from './office.ts';

export type Facility = 'ESTADIO' | 'CT' | 'BASE' | 'DEPTO_MEDICO';
export const FACILITY_LABEL: Record<Facility, string> = { ESTADIO: 'Estádio', CT: 'Centro de treinamento', BASE: 'Divisão de base', DEPTO_MEDICO: 'Departamento médico' };
export const SECTOR_LABEL: Record<Sector, string> = { GERAL: 'Geral', ARQUIBANCADA: 'Arquibancada', CADEIRA: 'Cadeiras', CAMAROTE: 'Camarotes' };
const FACILITY_EFFECT: Record<Facility, string> = {
  ESTADIO: 'Conforto de todos os setores: mais público e ingresso mais valorizado.',
  CT: 'Os jogadores evoluem mais rápido no treino.',
  BASE: 'Mais jovens por peneira e com potencial maior. Jovens evoluem mais rápido.',
  DEPTO_MEDICO: 'Menos lesões e recuperação mais rápida.',
};

export interface Project {
  id: string; clubId: number;
  kind: 'AMPLIAR' | 'REFORMA' | 'NIVEL';
  facility: Facility; sector?: Sector; amount?: number;
  cost: number; paid: number; rounds: number; done: number;
  blockedSeats: number;            // lugares fechados durante a obra
  label: string;
}
export interface YouthInfo { arrivedSeason: number; startOvr: number; potLow: number; potHigh: number }
export interface ClubExtra {
  condition: Record<Facility, number>;   // 0..100
  extraIntakeSeason?: number;            // temporada em que fez peneira extra
}

// =============================================================== util
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clubOf = (room: Room, id: number) => room.world.clubs.find((c) => c.id === id)!;
const isHuman = (room: Room, id: number) => room.members.some((m) => m.clubId === id);
const staffSkill = (room: Room, clubId: number, role: string) => room.world.staff.find((s) => s.clubId === clubId && s.role === role)?.skill ?? 0;

function ensure(room: Room) {
  room.projects ??= [];
  room.clubExtra ??= {};
  room.youthInfo ??= {};
  room.trainingProgress ??= {};
}
export function extraOf(room: Room, clubId: number): ClubExtra {
  ensure(room);
  return (room.clubExtra![clubId] ??= { condition: { ESTADIO: 90, CT: 90, BASE: 90, DEPTO_MEDICO: 90 } });
}
const capacity = (c: GenClub) => c.sectors.reduce((s, x) => s + x.capacity, 0);
export const blockedSeats = (room: Room, clubId: number) =>
  (room.projects ?? []).filter((p) => p.clubId === clubId).reduce((s, p) => s + p.blockedSeats, 0);

/** Usado pelo motor na bilheteria. */
export function gateContext(room: Room, clubId: number) {
  return { capacityBlocked: blockedSeats(room, clubId), stadiumCondition: Math.round(extraOf(room, clubId).condition.ESTADIO) };
}
/** Bônus do departamento médico para médico e fisioterapeuta (até +25). */
export function medicalBonus(room: Room, clubId: number) {
  const c = clubOf(room, clubId), cond = extraOf(room, clubId).condition.DEPTO_MEDICO / 100;
  return Math.round(c.facilities.DEPTO_MEDICO * 2.5 * (0.6 + 0.4 * cond));
}

// ============================================================ custos
const SEAT_COST_BRL: Record<Sector, number> = { GERAL: 1_200, ARQUIBANCADA: 2_000, CADEIRA: 4_500, CAMAROTE: 35_000 };
export const EXPANSIONS: Record<Sector, number[]> = {
  GERAL: [2_000, 5_000, 10_000], ARQUIBANCADA: [2_000, 5_000, 10_000], CADEIRA: [500, 1_000, 3_000], CAMAROTE: [50, 100, 300],
};
const MAX_CAPACITY = 90_000;
export function expansionQuote(sector: Sector, amount: number) {
  return { cost: amount * SEAT_COST_BRL[sector] * 100, rounds: 2 + Math.ceil(amount / (sector === 'CAMAROTE' ? 100 : 2_500)) };
}
// Balanceamento: subir de nível custa ~35% menos e reforma ~60% menos que na versão
// anterior, para caber no caixa junto com as vendas de jogadores (mais disputadas).
export function levelQuote(f: Facility, level: number) {
  const next = level + 1;
  return { cost: Math.round(585_000 * next ** 1.7 / 1000) * 1000 * 100 * (f === 'ESTADIO' ? 1.6 : 1), rounds: 3 + next };
}
export function reformQuote(room: Room, clubId: number, f: Facility) {
  const c = clubOf(room, clubId), cond = extraOf(room, clubId).condition[f];
  const size = f === 'ESTADIO' ? capacity(c) / 20_000 : 1;
  return { cost: Math.max(50_000 * 100, Math.round((100 - cond) * c.facilities[f] * 4_800 * Math.max(0.5, size) / 1000) * 1000 * 100), rounds: f === 'ESTADIO' ? 2 : 1 };
}

// ========================================================== obras
export function startProject(room: Room, clubId: number, req: { tipo: Project['kind']; instalacao: Facility; setor?: Sector; quantidade?: number }): Project {
  ensure(room);
  const club = clubOf(room, clubId);
  const f = req.instalacao;
  if (!FACILITY_LABEL[f]) throw new OfficeError('Instalação inválida.');
  if (room.projects!.some((p) => p.clubId === clubId && p.facility === f)) throw new OfficeError(`Já existe uma obra em andamento em ${FACILITY_LABEL[f].toLowerCase()}.`);
  let p: Project;
  room.msgSeq = (room.msgSeq ?? 0) + 1;
  const id = `ob${room.season}-${room.msgSeq}`;
  if (req.tipo === 'AMPLIAR') {
    const sector = req.setor!;
    if (f !== 'ESTADIO' || !SECTOR_LABEL[sector]) throw new OfficeError('Escolha um setor do estádio.');
    const amount = Number(req.quantidade);
    if (!EXPANSIONS[sector].includes(amount)) throw new OfficeError('Quantidade de lugares inválida.');
    if (capacity(club) + amount > MAX_CAPACITY) throw new OfficeError(`O estádio não pode passar de ${MAX_CAPACITY.toLocaleString('pt-BR')} lugares.`);
    const q = expansionQuote(sector, amount);
    const sec = club.sectors.find((s) => s.sector === sector)!;
    p = { id, clubId, kind: 'AMPLIAR', facility: f, sector, amount, cost: q.cost, paid: 0, rounds: q.rounds, done: 0,
      blockedSeats: Math.round(Math.min(sec.capacity * 0.2, amount)), label: `Ampliação: +${amount.toLocaleString('pt-BR')} lugares (${SECTOR_LABEL[sector]})` };
  } else if (req.tipo === 'REFORMA') {
    const q = reformQuote(room, clubId, f);
    if (extraOf(room, clubId).condition[f] >= 97) throw new OfficeError('Essa instalação já está em ótimo estado.');
    p = { id, clubId, kind: 'REFORMA', facility: f, cost: q.cost, paid: 0, rounds: q.rounds, done: 0,
      blockedSeats: f === 'ESTADIO' ? Math.round(capacity(club) * 0.2) : 0, label: `Reforma: ${FACILITY_LABEL[f]}` };
  } else if (req.tipo === 'NIVEL') {
    const lvl = club.facilities[f];
    if (lvl >= 10) throw new OfficeError('Essa instalação já está no nível máximo.');
    const q = levelQuote(f, lvl);
    p = { id, clubId, kind: 'NIVEL', facility: f, cost: q.cost, paid: 0, rounds: q.rounds, done: 0,
      blockedSeats: f === 'ESTADIO' ? Math.round(capacity(club) * 0.1) : 0, label: `${FACILITY_LABEL[f]}: nível ${lvl} → ${lvl + 1}` };
  } else throw new OfficeError('Tipo de obra inválido.');
  if (room.settings.rules.blockSpendingWhenNegative && club.balance < p.cost / p.rounds) throw new OfficeError('Caixa insuficiente até para a primeira parcela da obra.');
  room.projects!.push(p);
  sendToClub(room, clubId, { type: 'DIRETORIA', title: `Obra iniciada: ${p.label}`,
    body: `Custo total de ${brl(p.cost)}, pago em ${p.rounds} parcelas de ${brl(Math.ceil(p.cost / p.rounds))} por rodada. Fica pronta em ${p.rounds} rodadas.${p.blockedSeats ? ` Durante a obra, ${p.blockedSeats.toLocaleString('pt-BR')} lugares ficam fechados.` : ''}` });
  return p;
}

export function cancelProject(room: Room, clubId: number, id: string) {
  ensure(room);
  const p = room.projects!.find((x) => x.id === id && x.clubId === clubId);
  if (!p) throw new OfficeError('Obra não encontrada.');
  room.projects = room.projects!.filter((x) => x !== p);
  sendToClub(room, clubId, { type: 'DIRETORIA', title: `Obra cancelada: ${p.label}`, body: `O valor já pago (${brl(p.paid)}) não volta.` });
}

// ========================================================== ingressos
export function setTicketPrices(room: Room, clubId: number, prices: Partial<Record<Sector, number>>) {
  const club = clubOf(room, clubId);
  for (const [sector, value] of Object.entries(prices) as [Sector, number][]) {
    const sec = club.sectors.find((s) => s.sector === sector);
    if (!sec) throw new OfficeError('Setor inválido.');
    const ref = referencePrice(sector, club.reputation);
    if (!Number.isFinite(value) || value < 0) throw new OfficeError('Preço inválido.');
    if (value > ref * 6) throw new OfficeError(`${SECTOR_LABEL[sector]}: no máximo ${brl(ref * 6)} (6 vezes o preço justo).`);
    sec.ticketPrice = Math.round(value / 100) * 100;   // arredonda em R$ 1
  }
}

/** Público e renda estimados para o próximo jogo em casa (com os preços informados). */
export function gatePreview(room: Room, clubId: number, prices?: Partial<Record<Sector, number>>) {
  const club = clubOf(room, clubId);
  const next = room.world.fixtures.filter((f) => f.homeId === clubId && f.round > room.round).sort((a, b) => a.round - b.round)[0];
  const opp = next ? clubOf(room, next.awayId) : null;
  const sectors = club.sectors.map((s) => ({ ...s, ticketPrice: prices?.[s.sector] ?? s.ticketPrice }));
  const g = computeGate({
    sectors, ...gateContext(room, clubId), fanBase: club.fanBase, fanMood: club.fanMood, reputation: club.reputation,
    opponentReputation: opp?.reputation ?? 50, isDerby: !!opp && (club.rivalId === opp.id || opp.rivalId === club.id),
  });
  return {
    rodada: next?.round ?? null, adversario: opp ? { id: opp.id, nome: opp.name } : null,
    publico: g.attendance, renda: g.revenue, humor: g.moodDelta, motivo: g.moodReason ?? null,
    setores: g.bySector.map((x) => ({ setor: x.sector, vendidos: x.sold, procura: x.demand, renda: x.revenue })),
  };
}

// ======================================================= divisão de base
export const YOUTH_MAX = 24;
function youthCoach(room: Room, clubId: number) { return staffSkill(room, clubId, 'TREINADOR_BASE') || 40; }

/** Faixa de potencial que o clube enxerga: treinador da base melhor = faixa mais estreita. */
function potentialRange(room: Room, clubId: number, p: GenPlayer) {
  const err = Math.round(2 + (100 - youthCoach(room, clubId)) / 9);
  const shift = ((p.id * 7) % (err * 2 + 1)) - err;          // erro fixo por jogador
  const mid = clamp(p.potential + Math.round(shift / 2), 30, 99);
  return { low: clamp(mid - err, 30, 99), high: clamp(mid + err, 30, 99) };
}

function makeYouth(room: Room, club: GenClub, n?: number): GenPlayer[] {
  ensure(room);
  const rng = new Rng(Math.floor(Math.random() * 2_000_000_000));
  let nextId = Math.max(...room.world.players.map((p) => p.id));
  const cond = extraOf(room, club.id).condition.BASE / 100;
  const lvl = clamp(Math.round(club.facilities.BASE * (0.7 + 0.3 * cond)), 1, 10);
  let raw = generateYouthIntake(lvl, youthCoach(room, club.id), rng, () => ++nextId);
  if (n !== undefined) raw = raw.slice(0, n);
  // nomes repetidos no mesmo clube confundem: sorteia outro
  const taken = new Set(room.world.players.filter((p) => p.clubId === club.id).map((p) => p.name));
  for (const p of raw) {
    for (let i = 0; taken.has(p.name) && i < 30; i++) p.name = `${FIRST[rng.int(0, FIRST.length - 1)]} ${LAST[rng.int(0, LAST.length - 1)]}`;
    taken.add(p.name);
  }
  const out = raw.map((p) => ({
    ...p, clubId: club.id, isYouth: true, weeklySalary: 50_000 + overall(p) * 2_000, contractEnd: room.season + 3,
    marketValue: marketValue(overall(p), p.age, p.potential),
  }));
  for (const p of out) {
    room.world.players.push(p);
    const r = potentialRange(room, club.id, p);
    room.youthInfo![p.id] = { arrivedSeason: room.season, startOvr: overall(p), potLow: r.low, potHigh: r.high };
  }
  // base cheia: dispensa os de menor potencial
  const youth = room.world.players.filter((p) => p.clubId === club.id && p.isYouth);
  if (youth.length > YOUTH_MAX) for (const p of youth.sort((a, b) => a.potential - b.potential).slice(0, youth.length - YOUTH_MAX)) { p.clubId = null; p.isYouth = false; }
  return out;
}

export function extraIntake(room: Room, clubId: number) {
  const club = clubOf(room, clubId), ex = extraOf(room, clubId);
  if (ex.extraIntakeSeason === room.season) throw new OfficeError('A peneira extra já foi feita nesta temporada.');
  const cost = extraIntakeCost(club);
  if (room.settings.rules.blockSpendingWhenNegative && club.balance < cost) throw new OfficeError(`Caixa insuficiente (${brl(cost)}).`);
  pay(room, club, 'Base', cost);
  ex.extraIntakeSeason = room.season;
  const got = makeYouth(room, club, 3);
  sendToClub(room, clubId, { type: 'DIRETORIA', title: 'Peneira extra realizada', body: `Chegaram ${got.length} jovens: ${got.map((p) => `${p.name} (${p.position}, ${p.age})`).join(', ')}.` });
  return got;
}
export const extraIntakeCost = (club: GenClub) => club.facilities.BASE * 150_000 * 100;

export function promoteYouth(room: Room, clubId: number, playerId: number) {
  const p = room.world.players.find((x) => x.id === playerId && x.clubId === clubId && x.isYouth);
  if (!p) throw new OfficeError('Jogador não encontrado na base.');
  const squad = room.world.players.filter((x) => x.clubId === clubId && !x.isYouth).length;
  if (squad >= room.settings.rules.squadMax) throw new OfficeError(`O elenco profissional já tem ${room.settings.rules.squadMax} jogadores.`);
  p.isYouth = false;
  p.weeklySalary = Math.max(p.weeklySalary, Math.round(salaryFor(overall(p), DIFFICULTY[room.settings.difficulty].wageDemands) * 0.6));
  p.contractEnd = room.season + 3;
  p.morale = Math.min(100, p.morale + 15);
  p.popularity = Math.max(p.popularity, 15);      // cria da casa: torcida gosta
  sendToClub(room, clubId, { type: 'DIRETORIA', playerId: p.id, title: `${p.name} promovido ao profissional`,
    body: `${p.name} (${p.position}, ${p.age} anos, geral ${overall(p)}) assina contrato até a temporada ${p.contractEnd} por ${brl(p.weeklySalary)} por semana.` });
}

export function releaseYouth(room: Room, clubId: number, playerId: number) {
  const p = room.world.players.find((x) => x.id === playerId && x.clubId === clubId && x.isYouth);
  if (!p) throw new OfficeError('Jogador não encontrado na base.');
  p.clubId = null; p.isYouth = false;
}

// ======================================================= evolução (treino)
const DEFAULT_PLAN: Partial<Record<TrainingFocus, number>> = { FISICO: 22, TECNICO: 24, TATICO: 18, FINALIZACAO: 14, DEFESA: 14, GOLEIRO: 8 };

/** Evolução semanal de todos os jogadores: treino (CT ou base), idade e potencial. */
function developPlayers(room: Room) {
  ensure(room);
  const rng = new Rng(Math.floor(Math.random() * 2_000_000_000));
  const tp = room.trainingProgress!;
  // o ritmo de evolução é por temporada, seja ela de 14 ou 38 rodadas
  const roundsPerSeason = Math.max(...room.world.fixtures.map((f) => f.round));
  const scale = 1.5 * 38 / roundsPerSeason;
  for (const p of room.world.players) {
    if (p.clubId === null) continue;
    const c = clubOf(room, p.clubId), ex = extraOf(room, p.clubId);
    const fac: Facility = p.isYouth ? 'BASE' : 'CT';
    const res = applyTraining(p, {
      plan: DEFAULT_PLAN,
      coachSkill: p.isYouth ? youthCoach(room, p.clubId) : staffSkill(room, p.clubId, 'TECNICO') || 50,
      fitnessCoach: staffSkill(room, p.clubId, 'PREP_FISICO'), goalkeeperCoach: staffSkill(room, p.clubId, 'TREINADOR_GOLEIROS'),
      physio: staffSkill(room, p.clubId, 'FISIOTERAPEUTA'), ctLevel: c.facilities[fac], ctCondition: ex.condition[fac],
    }, rng);
    const acc = (tp[p.id] ??= {});
    for (const [a, v] of Object.entries(res.progress) as [Attribute, number][]) {
      acc[a] = (acc[a] ?? 0) + v * (v > 0 ? scale : scale * 0.4);
      while (acc[a]! >= 1) { if (p.attrs[a] < 99) p.attrs[a]++; acc[a]! -= 1; }
      while (acc[a]! <= -1) { if (p.attrs[a] > 1) p.attrs[a]--; acc[a]! += 1; }
    }
  }
}

// ======================================================= a cada rodada
export function clubAfterRound(room: Room) {
  ensure(room);
  // obras: parcela, avanço, conclusão
  for (const p of [...room.projects!]) {
    const club = clubOf(room, p.clubId);
    const part = Math.min(p.cost - p.paid, Math.ceil(p.cost / p.rounds));
    pay(room, club, 'Obras', part);
    p.paid += part; p.done++;
    if (p.done < p.rounds) continue;
    room.projects = room.projects!.filter((x) => x !== p);
    const ex = extraOf(room, p.clubId);
    let result = '';
    if (p.kind === 'AMPLIAR') {
      const sec = club.sectors.find((s) => s.sector === p.sector)!;
      sec.capacity += p.amount!;
      result = `${SECTOR_LABEL[p.sector!]} agora tem ${sec.capacity.toLocaleString('pt-BR')} lugares (estádio: ${capacity(club).toLocaleString('pt-BR')}).`;
    } else if (p.kind === 'REFORMA') {
      ex.condition[p.facility] = 100;
      if (p.facility === 'ESTADIO') for (const s of club.sectors) s.comfort = clamp(s.comfort + 8, 1, 100);
      result = `${FACILITY_LABEL[p.facility]} está 100% conservado.`;
    } else {
      club.facilities[p.facility]++;
      ex.condition[p.facility] = Math.max(ex.condition[p.facility], 95);
      if (p.facility === 'ESTADIO') for (const s of club.sectors) s.comfort = clamp(s.comfort + 5, 1, 100);
      result = `${FACILITY_LABEL[p.facility]} chegou ao nível ${club.facilities[p.facility]}. ${FACILITY_EFFECT[p.facility]}`;
    }
    sendToClub(room, p.clubId, { type: 'DIRETORIA', title: `Obra concluída: ${p.label}`, body: result });
  }
  // desgaste das instalações (cerca de 15 a 20 pontos por temporada)
  for (const club of room.world.clubs) {
    const ex = extraOf(room, club.id);
    for (const f of Object.keys(ex.condition) as Facility[]) {
      const before = ex.condition[f];
      ex.condition[f] = clamp(before - (Math.random() < 0.5 ? 1 : 0), 20, 100);
      if (!isHuman(room, club.id)) { if (ex.condition[f] < 70) ex.condition[f] = 92; continue; }   // IA reforma sozinha
      if (before >= 60 && ex.condition[f] < 60) sendToClub(room, club.id, { type: 'DIRETORIA', title: `${FACILITY_LABEL[f]} precisa de reforma`,
        body: `O estado de conservação caiu para ${Math.round(ex.condition[f])}%. ${f === 'ESTADIO' ? 'Estádio malcuidado afasta público.' : 'Isso reduz o efeito da instalação.'}` });
    }
  }
  developPlayers(room);
}

/** Virada de temporada: peneira de todos os clubes e jovens que estouraram a idade. */
export function clubSeasonStart(room: Room) {
  ensure(room);
  for (const club of room.world.clubs) {
    const human = isHuman(room, club.id);
    const youth = room.world.players.filter((p) => p.clubId === club.id && p.isYouth);
    const squad = room.world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    const out: string[] = [];
    for (const p of youth.filter((x) => x.age >= 20)) {
      if (!human && overall(p) >= Math.min(...squad.map(overall)) && squad.length < room.settings.rules.squadMax) { p.isYouth = false; squad.push(p); continue; }
      p.clubId = null; p.isYouth = false; out.push(p.name);
    }
    if (!human) {   // IA promove os melhores de 18-19
      for (const p of youth.filter((x) => x.isYouth && x.age >= 18 && overall(x) >= 60 && x.clubId === club.id)) {
        if (squad.length >= room.settings.rules.squadMax - 1) break;
        p.isYouth = false; p.weeklySalary = Math.round(salaryFor(overall(p)) * 0.006) * 100; p.contractEnd = room.season + 3; squad.push(p);
      }
    }
    const got = makeYouth(room, club);
    if (!human) continue;
    if (out.length) sendToClub(room, club.id, { type: 'DIRETORIA', title: 'Jovens deixaram a base', body: `Passaram da idade (20 anos) sem promoção: ${out.join(', ')}.` });
    const best = [...got].sort((a, b) => room.youthInfo![b.id].potHigh - room.youthInfo![a.id].potHigh);
    sendToClub(room, club.id, { type: 'DIRETORIA', title: `Peneira: ${got.length} jovens chegaram à base`,
      body: `Destaques: ${best.slice(0, 3).map((p) => `${p.name} (${p.position}, ${p.age} anos, potencial ${room.youthInfo![p.id].potLow}–${room.youthInfo![p.id].potHigh})`).join('; ')}.` });
  }
}

function pay(room: Room, club: GenClub, label: string, amount: number) {
  if (!amount) return;
  club.balance -= amount;
  const cs = room.clubs[club.id];
  cs.expense[label] = (cs.expense[label] ?? 0) + amount;
  cs.lastRound.expense[label] = (cs.lastRound.expense[label] ?? 0) + amount;
}

// ============================================================= views
export function stadiumView(room: Room, clubId: number) {
  ensure(room);
  const club = clubOf(room, clubId), ex = extraOf(room, clubId);
  const last = room.clubs[clubId].lastGate;
  const projects = room.projects!.filter((p) => p.clubId === clubId);
  const busy = new Set(projects.map((p) => p.facility));
  return {
    nome: club.stadiumName, capacidade: capacity(club), fechados: blockedSeats(room, clubId), maximo: MAX_CAPACITY,
    setores: club.sectors.map((s) => ({
      setor: s.sector, nome: SECTOR_LABEL[s.sector], capacidade: s.capacity, preco: s.ticketPrice,
      precoJusto: referencePrice(s.sector, club.reputation), conforto: s.comfort,
      ultimoPublico: last?.setores.find((x) => x.setor === s.sector)?.vendidos ?? null,
      ampliacoes: EXPANSIONS[s.sector].map((n) => ({ lugares: n, ...expansionQuote(s.sector, n) })),
    })),
    ultimoJogo: last ?? null,
    previsao: gatePreview(room, clubId),
    instalacoes: (Object.keys(FACILITY_LABEL) as Facility[]).map((f) => ({
      tipo: f, nome: FACILITY_LABEL[f], nivel: club.facilities[f], estado: Math.round(ex.condition[f]), efeito: FACILITY_EFFECT[f],
      ocupada: busy.has(f), manutencao: club.facilities[f] ** 2 * 2_000 * 100,
      subir: club.facilities[f] < 10 ? levelQuote(f, club.facilities[f]) : null, reforma: reformQuote(room, clubId, f),
    })),
    obras: projects.map((p) => ({ id: p.id, instalacao: p.facility, setor: p.sector ?? null, nome: p.label, custo: p.cost, pago: p.paid, rodadas: p.rounds, feitas: p.done, fechados: p.blockedSeats })),
    caixa: club.balance,
  };
}

export function youthView(room: Room, clubId: number) {
  ensure(room);
  const club = clubOf(room, clubId), ex = extraOf(room, clubId);
  const youth = room.world.players.filter((p) => p.clubId === clubId && p.isYouth);
  const ATTR_LABEL: Record<Attribute, string> = { pace: 'Vel', stamina: 'Res', strength: 'For', passing: 'Pas', dribbling: 'Dri', finishing: 'Fin', defending: 'Def', heading: 'Cab', goalkeeping: 'Gol', vision: 'Vis' };
  return {
    nivel: club.facilities.BASE, estado: Math.round(ex.condition.BASE), treinador: youthCoach(room, clubId),
    maximo: YOUTH_MAX, peneiraExtra: ex.extraIntakeSeason === room.season ? null : extraIntakeCost(club),
    elencoProfissional: room.world.players.filter((p) => p.clubId === clubId && !p.isYouth).length, elencoMaximo: room.settings.rules.squadMax,
    jovens: youth.map((p) => {
      const info = room.youthInfo![p.id] ?? { arrivedSeason: room.season, startOvr: overall(p), ...(() => { const r = potentialRange(room, clubId, p); return { potLow: r.low, potHigh: r.high }; })() };
      room.youthInfo![p.id] ??= info;
      const keys = ATTRIBUTES.filter((k) => p.position === 'GOL' || k !== 'goalkeeping').sort((a, b) => p.attrs[b] - p.attrs[a]);
      return {
        id: p.id, nome: p.name, pos: p.position, idade: p.age, ovr: overall(p), potMin: info.potLow, potMax: info.potHigh,
        evolucao: overall(p) - info.startOvr, desde: info.arrivedSeason, caract: keys.slice(0, 2).map((k) => ATTR_LABEL[k]),
        attrs: p.attrs, salario: p.weeklySalary, ultimoAno: p.age >= 19,
      };
    }).sort((a, b) => b.potMax - a.potMax),
  };
}
