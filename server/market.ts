// Mercado de transferências.
//
// Comprar:
//  - jogador livre: negocia só o salário (CONTRATACAO);
//  - jogador de clube da IA: negocia o passe com o clube (TRANSFERENCIA) e, acertado,
//    o salário com o jogador (CONTRATACAO). O passe só é pago quando o jogador assina;
//  - jogador de outro técnico humano: se está à venda, paga o preço pedido e negocia o
//    salário; se não, manda uma proposta que o outro técnico aceita ou recusa.
// Vender: coloque jogadores à venda; clubes da IA fazem ofertas (VENDA).
// As regras da sala valem: janela de transferências, elenco máximo, caixa negativo.

import { marketValue } from '../sim/economy.ts';
import { overall } from '../sim/strength.ts';
import type { Attribute } from '../sim/types.ts';
import { salaryFor, type GenClub, type GenPlayer } from '../sim/worldgen.ts';
import { DIFFICULTY } from '../sim/settings.ts';
import type { Room } from './engine.ts';
import {
  OfficeError, brl, ensure, lastRoundOf, marketHooks, playerDemand, playerOf, preferredSeasons, rand, roundMoney, sendToClub,
  type Negotiation, type Terms,
} from './office.ts';

export interface Listing { playerId: number; price: number; since: number; season: number }
export interface HumanOffer {
  id: string; buyerClubId: number; sellerClubId: number; playerId: number; fee: number;
  status: 'PENDENTE' | 'ACEITA' | 'RECUSADA' | 'CANCELADA'; season: number; round: number;
}

/** Funções do motor que o mercado usa (o motor registra ao carregar, evita import circular). */
export const marketEnv: { repairTactics?: (room: Room, clubId: number) => void; news?: (room: Room, text: string) => void } = {};

const ATTR_LABEL: Record<Attribute, string> = {
  pace: 'Vel', stamina: 'Res', strength: 'For', passing: 'Pas', dribbling: 'Dri',
  finishing: 'Fin', defending: 'Def', heading: 'Cab', goalkeeping: 'Gol', vision: 'Vis',
};
const MIN_SQUAD_TO_SELL = 16;

// ================================================================ util
const clubOf = (room: Room, id: number) => room.world.clubs.find((c) => c.id === id)!;
const humanClubs = (room: Room) => new Set(room.members.filter((m) => m.clubId !== null).map((m) => m.clubId!));
const squadSize = (room: Room, clubId: number) => room.world.players.filter((p) => p.clubId === clubId && !p.isYouth).length;
export const currentValue = (p: GenPlayer) => marketValue(overall(p), p.age, p.potential);
export function characteristics(p: GenPlayer): string[] {
  const keys = (Object.keys(p.attrs) as Attribute[]).filter((k) => p.position === 'GOL' || k !== 'goalkeeping');
  return keys.sort((a, b) => p.attrs[b] - p.attrs[a]).slice(0, 2).map((k) => ATTR_LABEL[k]);
}

function ensureMarket(room: Room) {
  ensure(room);
  room.forSale ??= [];
  room.humanOffers ??= [];
  if (!room.marketSeeded) { refreshAIListings(room, true); room.marketSeeded = true; }
}
const listingOf = (room: Room, playerId: number) => room.forSale!.find((l) => l.playerId === playerId);

// ===================================================== janela
export function windowStatus(room: Room): { open: boolean; text: string } {
  const r = room.settings.rules;
  if (r.transferWindow === 'SEMPRE') return { open: true, text: 'Mercado aberto o ano todo.' };
  const last = lastRoundOf(room), half = Math.floor(last / 2), next = room.round + 1, w = r.windowRounds;
  if (room.round >= last) return { open: true, text: 'Janela aberta na virada da temporada.' };
  if (next <= w) return { open: true, text: `Janela aberta até a rodada ${w}.` };
  if (next > half && next <= half + w) return { open: true, text: `Janela aberta até a rodada ${half + w}.` };
  return { open: false, text: next <= half ? `Janela fechada. Reabre na rodada ${half + 1}.` : 'Janela fechada. Reabre na virada da temporada.' };
}

// ================================================ listas da IA
/** Clubes da IA colocam alguns jogadores à venda (reservas, mais velhos). */
function refreshAIListings(room: Room, initial = false) {
  const humans = humanClubs(room);
  const now = room.season * 1000 + room.round;
  // listas antigas da IA saem do mercado depois de ~12 rodadas
  room.forSale = room.forSale!.filter((l) => {
    const p = room.world.players.find((x) => x.id === l.playerId);
    if (!p || p.clubId === null) return false;
    return humans.has(p.clubId) || now - (l.season * 1000 + l.since) < 12;
  });
  for (const club of room.world.clubs) {
    if (humans.has(club.id)) continue;
    const squad = room.world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    const listed = squad.filter((p) => listingOf(room, p.id)).length;
    const want = (initial ? 2 : 1) - listed;
    if (want <= 0 || squad.length <= room.settings.rules.squadMin + 1) continue;
    const ranked = [...squad].sort((a, b) => (overall(a) - (a.age >= 31 ? 6 : 0)) - (overall(b) - (b.age >= 31 ? 6 : 0)));
    for (const p of ranked.slice(0, 6).sort(() => Math.random() - 0.5).slice(0, want)) {
      room.forSale!.push({ playerId: p.id, price: roundMoney(currentValue(p) * rand(0.85, 1.15)), since: room.round, season: room.season });
    }
  }
}

/** Depois de cada rodada: renova listas da IA, a IA faz ofertas por jogadores à venda dos humanos. */
export function marketAfterRound(room: Room) {
  ensureMarket(room);
  if (room.round % 6 === 0) refreshAIListings(room);
  const humans = humanClubs(room);
  if (!windowStatus(room).open) return;
  for (const l of room.forSale!) {
    const p = room.world.players.find((x) => x.id === l.playerId);
    if (!p || p.clubId === null || !humans.has(p.clubId)) continue;
    if (room.negotiations!.some((n) => n.kind === 'VENDA' && n.playerId === p.id && n.status === 'ABERTA')) continue;
    if (Math.random() > 0.3) continue;
    const ovr = overall(p);
    const buyers = room.world.clubs.filter((c) => !humans.has(c.id) && c.balance > l.price * 0.7 && c.level >= ovr - 12 && c.level <= ovr + 15);
    if (!buyers.length) continue;
    const buyer = buyers[Math.floor(Math.random() * buyers.length)];
    openNeg(room, {
      kind: 'VENDA', clubId: p.clubId, playerId: p.id, otherClubId: buyer.id,
      current: { amount: roundMoney(l.price * rand(0.75, 0.95)), seasons: 1 }, maxAmount: roundMoney(l.price * rand(0.95, 1.2)),
      patience: Math.round(rand(2, 4)), expires: room.round + 3,
      opening: `O ${buyer.name} oferece ${'%V'} por ${p.name}.`,
    });
    const n = room.negotiations!.at(-1)!;
    sendToClub(room, p.clubId, { type: 'MERCADO', negId: n.id, playerId: p.id, title: `Oferta por ${p.name}`,
      body: `O ${buyer.name} oferece ${brl(n.current.amount)} por ${p.name} (você pede ${brl(l.price)}). A oferta vale até a rodada ${n.expiresRound}.` });
  }
}

function openNeg(room: Room, o: {
  kind: Negotiation['kind']; clubId: number; playerId: number; otherClubId?: number; fee?: number;
  current: Terms; minAmount?: number; maxAmount?: number; preferred?: number; patience: number; expires: number; opening: string;
}): Negotiation {
  const n: Negotiation = {
    id: `neg${room.season}-${++room.msgSeq!}`, kind: o.kind, clubId: o.clubId, status: 'ABERTA', season: room.season,
    expiresRound: Math.min(lastRoundOf(room), o.expires), patience: o.patience, patienceMax: o.patience,
    current: o.current, preferredSeasons: o.preferred ?? o.current.seasons, playerId: o.playerId,
    minAmount: o.minAmount, maxAmount: o.maxAmount, otherClubId: o.otherClubId, fee: o.fee, history: [],
  };
  n.history.push({ from: 'OUTRO', terms: { ...n.current }, at: Date.now(), text: o.opening.replace('%V', brl(n.current.amount)) });
  room.negotiations!.push(n);
  return n;
}

// ============================================================ busca
export interface SearchFilters {
  nome?: string; pos?: string; idadeMin?: number; idadeMax?: number; forcaMin?: number; valorMax?: number;
  carac?: string; divisao?: string; aVenda?: boolean; livres?: boolean; ocultarMeu?: boolean;
}

export function searchPlayers(room: Room, myClubId: number, f: SearchFilters) {
  ensureMarket(room);
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const q = f.nome ? norm(f.nome) : '';
  const rows = room.world.players.filter((p) => {
    if (p.isYouth) return false;
    if (f.ocultarMeu && p.clubId === myClubId) return false;
    if (f.livres && p.clubId !== null) return false;
    if (f.aVenda && !listingOf(room, p.id) && p.clubId !== null) return false;
    if (q && !norm(p.name).includes(q)) return false;
    if (f.pos && p.position !== f.pos) return false;
    if (f.idadeMin && p.age < f.idadeMin) return false;
    if (f.idadeMax && p.age > f.idadeMax) return false;
    if (f.forcaMin && overall(p) < f.forcaMin) return false;
    if (f.valorMax && currentValue(p) > f.valorMax) return false;
    if (f.carac && !characteristics(p).includes(f.carac)) return false;
    if (f.divisao) {
      if (f.divisao === 'livre') { if (p.clubId !== null) return false; }
      else if (p.clubId === null || clubOf(room, p.clubId).tier !== Number(f.divisao)) return false;
    }
    return true;
  }).sort((a, b) => overall(b) - overall(a));
  return { total: rows.length, jogadores: rows.slice(0, 300).map((p) => playerRow(room, p)), janela: windowStatus(room) };
}

function playerRow(room: Room, p: GenPlayer) {
  const s = room.status[p.id];
  const club = p.clubId !== null ? clubOf(room, p.clubId) : null;
  return {
    id: p.id, nome: p.name, pos: p.position, idade: p.age, ovr: overall(p), pot: p.potential,
    clube: club ? { id: club.id, nome: club.name, sigla: club.shortName, divisao: club.tier } : null,
    salario: p.weeklySalary, valor: currentValue(p), caract: characteristics(p), aVenda: listingOf(room, p.id)?.price ?? null,
    gols: s?.goals ?? 0, jogos: s?.apps ?? 0, nota: s?.apps ? Math.round((s.ratingSum / s.apps) * 10) / 10 : null,
    fimContrato: p.contractEnd,
  };
}

export function playerDetail(room: Room, myClubId: number, playerId: number) {
  ensureMarket(room);
  const p = room.world.players.find((x) => x.id === playerId);
  if (!p) throw new OfficeError('Jogador não encontrado.');
  const humans = humanClubs(room);
  const neg = room.negotiations!.find((n) => n.playerId === p.id && n.clubId === myClubId && n.status === 'ABERTA');
  const offer = room.humanOffers!.find((o) => o.playerId === p.id && o.buyerClubId === myClubId && o.status === 'PENDENTE');
  return {
    ...playerRow(room, p), attrs: p.attrs, moral: p.morale, forma: p.form, popularidade: p.popularity,
    meu: p.clubId === myClubId, donoHumano: p.clubId !== null && humans.has(p.clubId) && p.clubId !== myClubId,
    lesionado: room.status[p.id]?.injured ?? 0, negociacao: neg?.id ?? null, propostaPendente: offer ? offer.fee : null,
    janela: windowStatus(room),
  };
}

// ======================================================== interesse
/** Começa a negociar um jogador. `fee` só é usado em proposta para outro técnico humano. */
export function startInterest(room: Room, myClubId: number, playerId: number, fee?: number): { negId?: string; offerId?: string } {
  ensureMarket(room);
  const p = room.world.players.find((x) => x.id === playerId);
  if (!p || p.isYouth) throw new OfficeError('Jogador não encontrado.');
  if (p.clubId === myClubId) throw new OfficeError('Esse jogador já é seu.');
  const open = room.negotiations!.find((n) => n.playerId === p.id && n.clubId === myClubId && n.status === 'ABERTA');
  if (open) return { negId: open.id };
  const w = windowStatus(room);
  if (!w.open) throw new OfficeError(w.text);
  if (squadSize(room, myClubId) >= room.settings.rules.squadMax) throw new OfficeError(`Seu elenco já tem o máximo de ${room.settings.rules.squadMax} jogadores. Venda ou libere alguém antes.`);
  const me = clubOf(room, myClubId);

  if (p.clubId === null) return { negId: openSigning(room, me, p, 0, undefined).id };

  const seller = clubOf(room, p.clubId);
  const listing = listingOf(room, p.id);
  if (humanClubs(room).has(seller.id)) {
    if (listing) return { negId: openSigning(room, me, p, listing.price, seller.id).id };
    if (!fee || fee <= 0) throw new OfficeError('Informe o valor da proposta.');
    if (room.humanOffers!.some((o) => o.playerId === p.id && o.buyerClubId === myClubId && o.status === 'PENDENTE'))
      throw new OfficeError('Você já tem uma proposta aguardando resposta por esse jogador.');
    const offer: HumanOffer = { id: `of${++room.msgSeq!}`, buyerClubId: myClubId, sellerClubId: seller.id, playerId: p.id,
      fee: roundMoney(fee), status: 'PENDENTE', season: room.season, round: room.round };
    room.humanOffers!.push(offer);
    sendToClub(room, seller.id, { type: 'MERCADO', offerId: offer.id, playerId: p.id, title: `Proposta do ${me.name} por ${p.name}`,
      body: `O ${me.name} oferece ${brl(offer.fee)} por ${p.name} (valor de mercado ${brl(currentValue(p))}). Aceite ou recuse.` });
    return { offerId: offer.id };
  }

  // clube da IA: primeiro o passe
  const squad = room.world.players.filter((x) => x.clubId === seller.id && !x.isYouth).sort((a, b) => overall(b) - overall(a));
  const key = squad.indexOf(p) < 3;
  let base = listing ? listing.price : currentValue(p) * (key ? 1.7 : 1.3);
  if (p.contractEnd <= room.season) base *= 0.6;                         // contrato acabando: vale menos
  if (squad.length <= room.settings.rules.squadMin) base *= 1.3;         // elenco curto: segura
  const n = openNeg(room, {
    kind: 'TRANSFERENCIA', clubId: myClubId, playerId: p.id, otherClubId: seller.id,
    current: { amount: roundMoney(base * rand(1.0, 1.1)), seasons: 1 }, minAmount: roundMoney(base * rand(0.78, 0.92)),
    patience: Math.round(rand(2, 4)), expires: room.round + 3,
    opening: `O ${seller.name} pede ${'%V'} pelo passe de ${p.name}.`,
  });
  return { negId: n.id };
}

function openSigning(room: Room, me: GenClub, p: GenPlayer, fee: number, sellerId: number | undefined): Negotiation {
  let demand = playerDemand(room, p, me);
  if (p.clubId !== null) {
    const from = clubOf(room, p.clubId);
    if (me.tier > from.tier) demand *= 1 + 0.15 * (me.tier - from.tier);   // descer de divisão custa caro
    else if (me.tier < from.tier) demand *= 0.95;                            // subir de divisão atrai
    demand = Math.max(demand, p.weeklySalary * 1.05);
  }
  const pref = preferredSeasons(p.age);
  const patience = p.morale >= 60 ? 4 : 3;
  return openNeg(room, {
    kind: 'CONTRATACAO', clubId: me.id, playerId: p.id, otherClubId: sellerId, fee,
    current: { amount: roundMoney(demand * rand(1.08, 1.2)), seasons: pref }, minAmount: roundMoney(demand * rand(0.9, 0.98)), preferred: pref,
    patience, expires: room.round + 3,
    opening: `${fee ? `Passe acertado em ${brl(fee)}. ` : ''}Para jogar no ${me.name} quero ${'%V'} por semana, por ${pref} temporada${pref > 1 ? 's' : ''}.`,
  });
}

/** Resposta do técnico humano a uma proposta de outro humano. */
export function answerHumanOffer(room: Room, myClubId: number, offerId: string, accept: boolean) {
  ensureMarket(room);
  const o = room.humanOffers!.find((x) => x.id === offerId && x.sellerClubId === myClubId);
  if (!o) throw new OfficeError('Proposta não encontrada.');
  if (o.status !== 'PENDENTE') throw new OfficeError('Essa proposta já foi respondida.');
  const p = room.world.players.find((x) => x.id === o.playerId)!;
  if (p.clubId !== myClubId) { o.status = 'CANCELADA'; throw new OfficeError('Esse jogador não é mais seu.'); }
  const buyer = clubOf(room, o.buyerClubId), seller = clubOf(room, o.sellerClubId);
  if (!accept) {
    o.status = 'RECUSADA';
    sendToClub(room, o.buyerClubId, { type: 'MERCADO', playerId: p.id, title: `${seller.name} recusou`, body: `Sua proposta de ${brl(o.fee)} por ${p.name} foi recusada.` });
    return;
  }
  const w = windowStatus(room);
  if (!w.open) throw new OfficeError(w.text);
  if (squadSize(room, myClubId) - 1 < MIN_SQUAD_TO_SELL) throw new OfficeError(`Seu elenco ficaria com menos de ${MIN_SQUAD_TO_SELL} jogadores.`);
  o.status = 'ACEITA';
  const n = openSigning(room, buyer, p, o.fee, seller.id);
  sendToClub(room, o.buyerClubId, { type: 'MERCADO', negId: n.id, playerId: p.id, title: `${seller.name} aceitou vender ${p.name}`,
    body: `Passe de ${brl(o.fee)} acertado. Agora negocie o salário com o jogador. O passe só é pago quando ele assinar.` });
}

// ============================================================= vender
export function setForSale(room: Room, clubId: number, playerId: number, price: number | null) {
  ensureMarket(room);
  const p = room.world.players.find((x) => x.id === playerId && x.clubId === clubId);
  if (!p) throw new OfficeError('Esse jogador não é do seu elenco.');
  room.forSale = room.forSale!.filter((l) => l.playerId !== playerId);
  if (price === null) return null;
  if (!(price > 0)) throw new OfficeError('Informe o preço.');
  const l: Listing = { playerId, price: roundMoney(price), since: room.round, season: room.season };
  room.forSale!.push(l);
  return l;
}
export const listingPrice = (room: Room, playerId: number) => (room.forSale ?? []).find((l) => l.playerId === playerId)?.price ?? null;

// ===================================================== fechar negócio
/** Pode fechar agora? Janela, elenco e caixa. */
function check(room: Room, n: Negotiation): string | null {
  const w = windowStatus(room);
  if (!w.open && n.kind !== 'TRANSFERENCIA') return w.text;
  const p = playerOf(room, n);
  if (n.kind === 'VENDA') {
    if (p.clubId !== n.clubId) return 'Esse jogador não é mais seu.';
    if (squadSize(room, n.clubId) - 1 < MIN_SQUAD_TO_SELL) return `Seu elenco ficaria com menos de ${MIN_SQUAD_TO_SELL} jogadores.`;
    return null;
  }
  if (n.kind === 'CONTRATACAO') {
    if ((n.otherClubId ?? null) !== p.clubId) return 'Esse jogador já mudou de clube.';
    if (squadSize(room, n.clubId) >= room.settings.rules.squadMax) return `Seu elenco já tem o máximo de ${room.settings.rules.squadMax} jogadores.`;
    const me = clubOf(room, n.clubId);
    if (n.fee && room.settings.rules.blockSpendingWhenNegative && me.balance < n.fee) return `Caixa insuficiente para pagar o passe de ${brl(n.fee)}.`;
  }
  if (n.kind === 'TRANSFERENCIA' && p.clubId !== n.otherClubId) return 'Esse jogador já mudou de clube.';
  return null;
}

function closeDeal(room: Room, n: Negotiation, t: Terms) {
  const p = playerOf(room, n);
  if (n.kind === 'TRANSFERENCIA') {
    // passe acertado: agora o salário com o jogador
    const next = openSigning(room, clubOf(room, n.clubId), p, t.amount, n.otherClubId);
    n.history.push({ from: 'OUTRO', terms: t, at: Date.now(), text: `Negócio fechado no passe: ${brl(t.amount)}. Agora acerte o salário com ${p.name}.` });
    (n as Negotiation & { next?: string }).next = next.id;
    sendToClub(room, n.clubId, { type: 'MERCADO', negId: next.id, playerId: p.id, title: `Passe de ${p.name} acertado`,
      body: `O ${clubOf(room, n.otherClubId!).name} aceita ${brl(t.amount)}. Negocie o salário com o jogador; o passe só é pago quando ele assinar.` });
    return;
  }
  if (n.kind === 'CONTRATACAO') {
    const contractEnd = room.season + t.seasons - (room.round >= lastRoundOf(room) ? 0 : 1);
    transfer(room, p, n.clubId, n.fee ?? 0, t.amount, contractEnd);
    n.history.push({ from: 'OUTRO', terms: t, at: Date.now(), text: `Assinado! Contrato até a temporada ${contractEnd}.` });
    return;
  }
  // VENDA: clube da IA compra o nosso jogador
  const buyer = clubOf(room, n.otherClubId!);
  const diff = DIFFICULTY[room.settings.difficulty];
  transfer(room, p, buyer.id, t.amount, Math.max(p.weeklySalary, salaryFor(overall(p), diff.wageDemands)), room.season + Math.round(rand(1, 3)));
  n.history.push({ from: 'OUTRO', terms: t, at: Date.now(), text: `Negócio fechado: ${p.name} vai para o ${buyer.name}.` });
}

function transfer(room: Room, p: GenPlayer, toClubId: number, fee: number, salary: number, contractEnd: number) {
  const fromClubId = p.clubId;
  const to = clubOf(room, toClubId);
  const money = (club: GenClub, amount: number) => {
    club.balance += amount;
    const cs = room.clubs[club.id];
    const book = amount > 0 ? 'income' : 'expense';
    cs[book]['Transferências'] = (cs[book]['Transferências'] ?? 0) + Math.abs(amount);
    cs.lastRound[book]['Transferências'] = (cs.lastRound[book]['Transferências'] ?? 0) + Math.abs(amount);
  };
  if (fee && fromClubId !== null) { money(to, -fee); money(clubOf(room, fromClubId), fee); }
  p.clubId = toClubId; p.weeklySalary = salary; p.contractEnd = contractEnd; p.isYouth = false;
  p.morale = Math.min(100, p.morale + 5);
  room.forSale = room.forSale!.filter((l) => l.playerId !== p.id);
  for (const x of room.negotiations!) if (x.playerId === p.id && x.status === 'ABERTA') x.status = 'EXPIRADA';
  for (const o of room.humanOffers!) if (o.playerId === p.id && o.status === 'PENDENTE') o.status = 'CANCELADA';
  if (fromClubId !== null) marketEnv.repairTactics?.(room, fromClubId);
  marketEnv.repairTactics?.(room, toClubId);
  const from = fromClubId !== null ? clubOf(room, fromClubId) : null;
  const what = `${p.name} (${p.position}, geral ${overall(p)})`;
  sendToClub(room, toClubId, { type: 'MERCADO', playerId: p.id, title: `${p.name} contratado`,
    body: `${what} chega${from ? ` do ${from.name}` : ' sem custo de passe'}${fee ? ` por ${brl(fee)}` : ''}. Salário de ${brl(salary)} por semana até a temporada ${contractEnd}.` });
  if (from) sendToClub(room, from.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} vendido`,
    body: `${what} foi para o ${to.name}${fee ? ` por ${brl(fee)}` : ''}.` });
  marketEnv.news?.(room, `Mercado: ${p.name} ${from ? `troca o ${from.name} pelo` : 'assina com o'} ${to.name}${fee ? ` (${brl(fee)})` : ''}.`);
}

function failed(room: Room, n: Negotiation) {
  if (n.kind === 'CONTRATACAO' && n.fee) {
    const p = playerOf(room, n);
    sendToClub(room, n.clubId, { type: 'MERCADO', playerId: p.id, title: `${p.name} não assinou`, body: 'Sem acordo de salário, o negócio caiu. Nenhum valor foi pago.' });
  }
}

marketHooks.check = check;
marketHooks.close = closeDeal;
marketHooks.failed = failed;
