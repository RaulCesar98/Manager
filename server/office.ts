// Escritório do clube: caixa de mensagens e negociação de contratos
// (renovação de jogadores e patrocínios).
//
// As negociações têm valores escondidos: o que o jogador aceita no mínimo e
// o máximo que o patrocinador topa pagar. Cada contraproposta gasta
// paciência; propostas muito fora da realidade gastam o dobro. Quando a
// paciência acaba, a outra parte encerra a conversa.

import { sponsorBreakFee, sponsorValuePerRound, winBonus, type SponsorSlot } from '../sim/fans.ts';
import { DIFFICULTY } from '../sim/settings.ts';
import { overall } from '../sim/strength.ts';
import { salaryFor, type GenClub, type GenPlayer, type GenSponsorship } from '../sim/worldgen.ts';
import type { Room } from './engine.ts';

// ================================================================ tipos
export type MessageType = 'LESAO' | 'SUSPENSAO' | 'TORCIDA' | 'PATROCINIO' | 'RENOVACAO' | 'CONTRATO' | 'DIRETORIA' | 'MERCADO';
export interface Message {
  id: number; at: number; season: number; round: number;
  type: MessageType; title: string; body: string; read: boolean;
  negId?: string; playerId?: number; offerId?: string; loanId?: string;
  mosaic?: import('./crowd.ts').MosaicDesign;   // imagem do mosaico (mensagens da torcida)
}

export interface Terms { amount: number; seasons: number }
/**
 * RENOVACAO    salário com jogador do próprio elenco (nós pagamos)
 * CONTRATACAO  salário com jogador que vai chegar (nós pagamos; passe já acertado em `fee`)
 * TRANSFERENCIA passe com o clube vendedor da IA (nós pagamos, valor único)
 * PATROCINIO   patrocinador paga por rodada (nós recebemos)
 * VENDA        clube da IA quer comprar um jogador nosso (nós recebemos, valor único)
 */
export type NegKind = 'RENOVACAO' | 'CONTRATACAO' | 'TRANSFERENCIA' | 'PATROCINIO' | 'VENDA';
const WE_PAY: NegKind[] = ['RENOVACAO', 'CONTRATACAO', 'TRANSFERENCIA'];
export const ONE_OFF: NegKind[] = ['TRANSFERENCIA', 'VENDA'];          // valor único, sem temporadas
export const unitOf = (k: NegKind) => k === 'PATROCINIO' ? 'por rodada' : ONE_OFF.includes(k) ? '' : 'por semana';   // amount: salário semanal ou valor por rodada (centavos)
export interface Negotiation {
  id: string;
  kind: NegKind;
  clubId: number;
  status: 'ABERTA' | 'ACEITA' | 'RECUSADA' | 'EXPIRADA';
  season: number;
  expiresRound: number;          // depois desta rodada, a proposta caduca
  patience: number;              // tentativas que sobram
  patienceMax: number;
  current: Terms;                // última proposta da outra parte
  preferredSeasons: number;
  history: { from: 'CLUBE' | 'OUTRO'; terms: Terms; text: string; at: number }[];
  // renovação
  playerId?: number;
  minAmount?: number;            // ESCONDIDO: menor salário que o jogador aceita
  // patrocínio
  sponsorId?: number;
  slot?: SponsorSlot;
  maxAmount?: number;            // ESCONDIDO: maior valor que o patrocinador paga
  renewal?: boolean;
  // mercado
  otherClubId?: number;          // vendedor (TRANSFERENCIA/CONTRATACAO) ou comprador (VENDA)
  fee?: number;                  // passe já acertado (CONTRATACAO)
}

/** O módulo de mercado registra aqui o que fazer quando um negócio de mercado fecha. */
export const marketHooks: {
  check?: (room: Room, n: Negotiation) => string | null;   // pode fechar agora? (janela, elenco, caixa)
  close?: (room: Room, n: Negotiation, t: Terms) => void;
  failed?: (room: Room, n: Negotiation) => void;
} = {};

export const SLOT_LABEL: Record<SponsorSlot, string> = {
  MASTER: 'Master (frente da camisa)', COSTAS: 'Costas da camisa', MANGA: 'Manga', ESTADIO: 'Placas do estádio', MATERIAL: 'Material esportivo',
};
const SLOTS: SponsorSlot[] = ['MASTER', 'MATERIAL', 'ESTADIO', 'COSTAS', 'MANGA'];

// ================================================================ util
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const roundMoney = (c: number) => Math.round(c / 10_000) * 10_000;   // arredonda em R$ 100
export const brl = (c: number) => 'R$ ' + Math.round(c / 100).toLocaleString('pt-BR');
const clubOf = (room: Room, id: number) => room.world.clubs.find((c) => c.id === id)!;
export const lastRoundOf = (room: Room) => Math.max(...room.world.fixtures.map((f) => f.round));

export function ensure(room: Room) {
  room.inbox ??= {};
  room.negotiations ??= [];
  room.msgSeq ??= 0;
}

// ============================================================ mensagens
export function sendToClub(room: Room, clubId: number, m: Omit<Message, 'id' | 'at' | 'season' | 'round' | 'read'>) {
  ensure(room);
  const member = room.members.find((x) => x.clubId === clubId);
  if (!member) return;                       // clube da IA: ninguém lê
  const box = (room.inbox![member.userId] ??= []);
  box.unshift({ ...m, id: ++room.msgSeq!, at: Date.now(), season: room.season, round: room.round, read: false });
  if (box.length > 150) box.length = 150;
}

export function inboxOf(room: Room, userId: string): Message[] {
  ensure(room);
  return room.inbox![userId] ?? [];
}

export function markRead(room: Room, userId: string, ids: number[] | 'all') {
  for (const m of inboxOf(room, userId)) if (ids === 'all' || ids.includes(m.id)) m.read = true;
}

// ======================================================== renovação
export function preferredSeasons(age: number) {
  return age <= 23 ? 3 : age <= 29 ? 4 : age <= 32 ? 3 : 2;
}

/** O que o jogador pede (centavos por semana). */
export function playerDemand(room: Room, p: GenPlayer, club: GenClub): number {
  const ovr = overall(p);
  let d = salaryFor(ovr, DIFFICULTY[room.settings.difficulty].wageDemands);
  if (p.age <= 23 && p.potential - ovr >= 8) d *= 1.15;   // promessa sabe o próprio valor
  d *= 1 + p.popularity / 250;                             // ídolo pede mais
  if (p.morale < 40) d *= 1.15; else if (p.morale > 75) d *= 0.95;
  d *= 1 + (55 - club.reputation) / 300;                   // clube pequeno precisa pagar mais
  const floor = p.age >= 32 ? p.weeklySalary * 0.85 : p.weeklySalary;
  return roundMoney(Math.max(d, floor));
}

export function canRenew(room: Room, p: GenPlayer) {
  return p.contractEnd <= room.season + 1;
}

export function openRenewal(room: Room, clubId: number, playerId: number): Negotiation {
  ensure(room);
  // jogador emprestado: quem renova é o dono do contrato, não o clube que o recebeu
  const loan = (room.loans ?? []).find((l) => l.playerId === playerId);
  if (loan && loan.borrowerId === clubId) throw new OfficeError('Jogador emprestado: só o clube dono do contrato pode renovar.');
  const p = room.world.players.find((x) => x.id === playerId && (x.clubId === clubId || loan?.ownerId === clubId));
  if (!p) throw new OfficeError('Esse jogador não é do seu elenco.');
  const open = room.negotiations!.find((n) => n.kind === 'RENOVACAO' && n.playerId === playerId && n.status === 'ABERTA');
  if (open) return open;
  const refused = room.negotiations!.find((n) => n.kind === 'RENOVACAO' && n.playerId === playerId && n.season === room.season && n.status === 'RECUSADA');
  if (refused) throw new OfficeError(`${p.name} não quer mais conversar sobre renovação nesta temporada.`);
  if (!canRenew(room, p)) throw new OfficeError(`O contrato de ${p.name} vai até a temporada ${p.contractEnd}. A renovação abre na temporada ${p.contractEnd - 1}.`);
  const demand = playerDemand(room, p, clubOf(room, clubId));
  const pref = preferredSeasons(p.age);
  const patience = p.morale >= 60 ? 4 : 3;
  const n: Negotiation = {
    id: `neg${room.season}-${++room.msgSeq!}`, kind: 'RENOVACAO', clubId, status: 'ABERTA', season: room.season,
    expiresRound: lastRoundOf(room), patience, patienceMax: patience,
    current: { amount: roundMoney(demand * rand(1.08, 1.18)), seasons: pref }, preferredSeasons: pref,
    playerId, minAmount: roundMoney(demand * rand(0.88, 0.97)), history: [],
  };
  n.history.push({ from: 'OUTRO', terms: { ...n.current }, at: Date.now(),
    text: `Quero ${brl(n.current.amount)} por semana, por ${pref} temporada${pref > 1 ? 's' : ''}.` });
  room.negotiations!.push(n);
  return n;
}

// ======================================================== patrocínio
function sponsorFair(room: Room, club: GenClub, slot: SponsorSlot) {
  return sponsorValuePerRound({ slot, fanBase: club.fanBase, reputation: club.reputation, divisionTier: club.tier, difficulty: DIFFICULTY[room.settings.difficulty] });
}

export const activeSponsorships = (room: Room, clubId: number) =>
  room.world.sponsorships.filter((s) => s.clubId === clubId && s.endSeason >= room.season);

function openSponsorOffer(room: Room, club: GenClub, slot: SponsorSlot, sponsorId: number, renewal: boolean) {
  ensure(room);
  const fair = sponsorFair(room, club, slot);
  const seasons = renewal ? 2 : Math.round(rand(1, 3));
  const patience = Math.round(rand(2, 4));
  const n: Negotiation = {
    id: `neg${room.season}-${++room.msgSeq!}`, kind: 'PATROCINIO', clubId: club.id, status: 'ABERTA', season: room.season,
    expiresRound: Math.min(lastRoundOf(room), room.round + 4), patience, patienceMax: patience,
    current: { amount: roundMoney(fair * rand(0.78, 0.95)), seasons }, preferredSeasons: seasons,
    sponsorId, slot, maxAmount: roundMoney(fair * rand(1.05, 1.25)), renewal, history: [],
  };
  const sp = room.world.sponsors.find((s) => s.id === sponsorId)!;
  n.history.push({ from: 'OUTRO', terms: { ...n.current }, at: Date.now(),
    text: `Oferecemos ${brl(n.current.amount)} por rodada, por ${seasons} temporada${seasons > 1 ? 's' : ''}, mais ${brl(winBonus(n.current.amount))} por vitória.` });
  room.negotiations!.push(n);
  sendToClub(room, club.id, {
    type: 'PATROCINIO', negId: n.id,
    title: renewal ? `${sp.name} quer renovar o patrocínio` : `Proposta de patrocínio: ${sp.name}`,
    body: `${sp.name} quer o espaço "${SLOT_LABEL[slot]}". Proposta inicial: ${brl(n.current.amount)} por rodada durante ${seasons} temporada${seasons > 1 ? 's' : ''}. A oferta vale até a rodada ${n.expiresRound}.`,
  });
}

export function breakSponsorship(room: Room, clubId: number, slot: SponsorSlot) {
  const club = clubOf(room, clubId);
  const c = activeSponsorships(room, clubId).find((s) => s.slot === slot);
  if (!c) throw new OfficeError('Não há patrocínio nesse espaço.');
  const roundsLeft = (c.endSeason - room.season) * lastRoundOf(room) + (lastRoundOf(room) - room.round);
  const fee = sponsorBreakFee(c.perRound, roundsLeft);
  club.balance -= fee;
  const cs = room.clubs[clubId];
  cs.expense['Multas'] = (cs.expense['Multas'] ?? 0) + fee;
  room.world.sponsorships = room.world.sponsorships.filter((s) => s !== c);
  const sp = room.world.sponsors.find((s) => s.id === c.sponsorId)!;
  sendToClub(room, clubId, { type: 'PATROCINIO', title: `Contrato com ${sp.name} rompido`, body: `O clube pagou ${brl(fee)} de multa rescisória. O espaço "${SLOT_LABEL[slot]}" está livre para novas propostas.` });
  return fee;
}

// ======================================================== negociação
export class OfficeError extends Error {}

/**
 * Ação do técnico numa negociação:
 * PROPOR (com valor e temporadas), ACEITAR (a última proposta da outra parte) ou ENCERRAR.
 */
export function negotiate(room: Room, clubId: number, negId: string, action: 'PROPOR' | 'ACEITAR' | 'ENCERRAR', terms?: Terms): Negotiation {
  ensure(room);
  const n = room.negotiations!.find((x) => x.id === negId && x.clubId === clubId);
  if (!n) throw new OfficeError('Negociação não encontrada.');
  if (n.status !== 'ABERTA') throw new OfficeError('Essa negociação já terminou.');
  const say = (text: string) => n.history.push({ from: 'OUTRO', terms: { ...n.current }, text, at: Date.now() });
  const T = texts(room, n);

  if (action === 'ENCERRAR') {
    n.status = 'RECUSADA';
    n.history.push({ from: 'CLUBE', terms: { ...n.current }, text: 'Encerramos a negociação.', at: Date.now() });
    if (n.kind === 'RENOVACAO') playerOf(room, n).morale = Math.max(0, playerOf(room, n).morale - 10);
    say(T.walkAway);
    marketHooks.failed?.(room, n);
    return n;
  }
  const blocker = marketHooks.check && ['CONTRATACAO', 'TRANSFERENCIA', 'VENDA'].includes(n.kind) ? marketHooks.check(room, n) : null;
  if (action === 'ACEITAR') {
    if (blocker) throw new OfficeError(blocker);
    close(room, n, n.current); return n;
  }

  // PROPOR
  if (!terms || !Number.isFinite(terms.amount) || terms.amount <= 0) throw new OfficeError('Informe um valor.');
  const maxSeasons = n.kind === 'PATROCINIO' ? 3 : 5;
  const seasons = ONE_OFF.includes(n.kind) ? 1 : Math.round(terms.seasons);
  if (seasons < 1 || seasons > maxSeasons) throw new OfficeError(`Contratos de 1 a ${maxSeasons} temporadas.`);
  const amount = roundMoney(terms.amount);
  const unit = unitOf(n.kind);
  n.history.push({ from: 'CLUBE', terms: { amount, seasons }, at: Date.now(),
    text: ONE_OFF.includes(n.kind) ? `Proposta: ${brl(amount)}.` : `Proposta: ${brl(amount)} ${unit}, ${seasons} temporada${seasons > 1 ? 's' : ''}.` });
  const yearGap = ONE_OFF.includes(n.kind) ? 0 : Math.abs(seasons - n.preferredSeasons);

  if (WE_PAY.includes(n.kind)) {
    // A outra parte tem um mínimo escondido. Tempo de contrato diferente do preferido custa 5%
    // por temporada. No começo está firme (até ~12% acima do mínimo) e cede a cada conversa.
    const floor = () => n.minAmount! * (1 + 0.05 * yearGap) * (1 + 0.03 * Math.max(0, n.patience - 1));
    const need = floor();
    if (amount >= need) {
      if (blocker) throw new OfficeError(blocker);
      close(room, n, { amount, seasons }); return n;
    }
    const insult = amount < need * 0.65;
    n.patience -= insult ? 2 : 1;
    if (n.patience <= 0) {
      n.status = 'RECUSADA';
      if (n.kind === 'RENOVACAO') { const p = playerOf(room, n); p.morale = Math.max(0, p.morale - 15); }
      say(insult ? T.insulted : T.noDeal);
      notifyEnd(room, n);
      marketHooks.failed?.(room, n);
      return n;
    }
    const ask = Math.max(floor() * 1.02, n.current.amount - (n.current.amount - amount) * 0.35);
    n.current = { amount: roundMoney(ask), seasons: yearGap ? n.preferredSeasons : seasons };
    say(insult ? T.tooLow(n.current.amount) : T.counter(n.current.amount, yearGap ? n.preferredSeasons : 0));
    return n;
  }

  // A outra parte paga (patrocínio, venda): tem um máximo escondido, começa segurando e libera
  // mais a cada contraproposta. Patrocínio mais longo vale 3% a mais por temporada.
  const limit = n.maxAmount! * (1 + 0.03 * (seasons - 1)) * (1 - 0.04 * Math.max(0, n.patience - 1));
  if (amount <= Math.max(limit, n.current.amount)) {
    if (blocker) throw new OfficeError(blocker);
    close(room, n, { amount, seasons }); return n;
  }
  const absurd = amount > limit * 1.5;
  n.patience -= absurd ? 2 : 1;
  if (n.patience <= 0) {
    n.status = 'RECUSADA';
    say(absurd ? T.insulted : T.noDeal);
    notifyEnd(room, n);
    marketHooks.failed?.(room, n);
    return n;
  }
  const offer = Math.min(limit, n.current.amount + (amount - n.current.amount) * 0.4);
  n.current = { amount: roundMoney(offer), seasons };
  say(absurd ? T.tooLow(n.current.amount) : T.counter(n.current.amount, 0));
  return n;
}

/** Falas da outra parte em cada tipo de negociação. */
function texts(room: Room, n: Negotiation) {
  const other = n.otherClubId ? clubOf(room, n.otherClubId).name : '';
  const sp = n.sponsorId ? room.world.sponsors.find((s) => s.id === n.sponsorId)!.name : '';
  const pref = (k: number) => k ? `, mas prefiro ${k} temporada${k > 1 ? 's' : ''}` : '';
  switch (n.kind) {
    case 'RENOVACAO': return {
      walkAway: 'Tudo bem. Vou procurar outro clube quando meu contrato acabar.',
      insulted: 'Isso é falta de respeito. Não vou renovar.', noDeal: 'Não chegamos a um acordo. Vou sair quando meu contrato acabar.',
      tooLow: (v: number) => `Isso está muito abaixo do meu valor. Meu pedido: ${brl(v)}.`,
      counter: (v: number, k: number) => `Posso baixar para ${brl(v)} por semana${pref(k)}.` };
    case 'CONTRATACAO': return {
      walkAway: 'Tudo bem. Boa sorte na temporada.',
      insulted: 'Com essa proposta não tenho interesse em ir para o seu clube.', noDeal: 'Não chegamos a um acordo. Vou continuar onde estou.',
      tooLow: (v: number) => `É pouco para eu mudar de clube. Meu pedido: ${brl(v)} por semana.`,
      counter: (v: number, k: number) => `Para ir, preciso de ${brl(v)} por semana${pref(k)}.` };
    case 'TRANSFERENCIA': return {
      walkAway: `O ${other} encerrou as conversas.`,
      insulted: `O ${other} considerou a oferta uma piada e encerrou as conversas.`, noDeal: `O ${other} não aceita vender por esse valor. Fim de papo.`,
      tooLow: (v: number) => `Muito abaixo. O ${other} pede ${brl(v)}.`,
      counter: (v: number) => `Por menos de ${brl(v)} o ${other} não vende.` };
    case 'VENDA': return {
      walkAway: `O ${other} vai procurar outras opções.`,
      insulted: `O ${other} achou o valor absurdo e desistiu.`, noDeal: `O ${other} não pode pagar isso e retirou a oferta.`,
      tooLow: (v: number) => `Muito acima do que podemos. Chegamos a ${brl(v)}.`,
      counter: (v: number) => `O ${other} sobe a oferta para ${brl(v)}.` };
    default: return {
      walkAway: 'Entendido. Fica para uma próxima.',
      insulted: 'Esse valor está fora da realidade. Vamos procurar outro clube.', noDeal: 'Não conseguimos chegar a esse valor. Retiramos a proposta.',
      tooLow: (v: number) => `Muito acima do que pagamos. Podemos chegar a ${brl(v)}.`,
      counter: (v: number) => `Subimos para ${brl(v)} por rodada.` };
  }
}

export const playerOf = (room: Room, n: Negotiation) => room.world.players.find((p) => p.id === n.playerId)!;

function close(room: Room, n: Negotiation, t: Terms) {
  n.status = 'ACEITA';
  n.current = t;
  if (n.kind === 'CONTRATACAO' || n.kind === 'TRANSFERENCIA' || n.kind === 'VENDA') { marketHooks.close!(room, n, t); return; }
  if (n.kind === 'RENOVACAO') {
    const p = playerOf(room, n);
    p.weeklySalary = t.amount;
    p.contractEnd = room.season + t.seasons;
    p.morale = Math.min(100, p.morale + 10);
    n.history.push({ from: 'OUTRO', terms: t, at: Date.now(), text: `Fechado! Contrato até a temporada ${p.contractEnd}.` });
    sendToClub(room, n.clubId, { type: 'RENOVACAO', negId: n.id, playerId: p.id, title: `${p.name} renovou`,
      body: `Novo contrato: ${brl(t.amount)} por semana até a temporada ${p.contractEnd}.` });
    return;
  }
  const slot = n.slot!;
  const club = clubOf(room, n.clubId);
  const perSeason = lastRoundOf(room);
  const endSeason = n.renewal ? room.season + t.seasons : room.season + t.seasons - 1;
  room.world.sponsorships = room.world.sponsorships.filter((s) => !(s.clubId === club.id && s.slot === slot && (s.endSeason >= room.season)));
  const contract: GenSponsorship = {
    sponsorId: n.sponsorId!, clubId: club.id, slot, perRound: t.amount, bonusPerWin: winBonus(t.amount),
    endSeason, breakFee: sponsorBreakFee(t.amount, (endSeason - room.season + 1) * perSeason),
  };
  room.world.sponsorships.push(contract);
  const sp = room.world.sponsors.find((s) => s.id === n.sponsorId)!;
  n.history.push({ from: 'OUTRO', terms: t, at: Date.now(), text: `Negócio fechado! Contrato até a temporada ${endSeason}.` });
  sendToClub(room, n.clubId, { type: 'PATROCINIO', negId: n.id, title: `Patrocínio fechado com ${sp.name}`,
    body: `${SLOT_LABEL[slot]}: ${brl(t.amount)} por rodada + ${brl(contract.bonusPerWin)} por vitória, até a temporada ${endSeason}.` });
}

function notifyEnd(room: Room, n: Negotiation) {
  const p = n.playerId ? playerOf(room, n) : null;
  if (n.kind === 'RENOVACAO') {
    sendToClub(room, n.clubId, { type: 'RENOVACAO', negId: n.id, playerId: p!.id, title: `${p!.name} recusou renovar`,
      body: `Sem acordo. ${p!.name} sai de graça ao fim da temporada ${p!.contractEnd}, a não ser que seja vendido antes.` });
  } else if (n.kind === 'PATROCINIO') {
    const sp = room.world.sponsors.find((s) => s.id === n.sponsorId)!;
    sendToClub(room, n.clubId, { type: 'PATROCINIO', negId: n.id, title: `${sp.name} desistiu`, body: `A negociação pelo espaço "${SLOT_LABEL[n.slot!]}" terminou sem acordo.` });
  } else {
    sendToClub(room, n.clubId, { type: 'MERCADO', negId: n.id, playerId: p!.id, title: `Negociação por ${p!.name} encerrada`, body: 'Não houve acordo.' });
  }
}

// ==================================================== a cada rodada
/** Ofertas novas, propostas que caducam e lembretes. Chamado depois de cada rodada. */
export function officeAfterRound(room: Room) {
  ensure(room);
  const humans = room.members.filter((m) => m.clubId !== null);
  const last = lastRoundOf(room);
  for (const n of room.negotiations!) {
    if (n.status !== 'ABERTA' || n.kind === 'RENOVACAO' || room.round <= n.expiresRound) continue;
    n.status = 'EXPIRADA';
    if (n.kind === 'PATROCINIO') {
      const sp = room.world.sponsors.find((s) => s.id === n.sponsorId)!;
      sendToClub(room, n.clubId, { type: 'PATROCINIO', negId: n.id, title: `Proposta da ${sp.name} expirou`, body: 'Você não respondeu a tempo.' });
    } else {
      const p = playerOf(room, n);
      sendToClub(room, n.clubId, { type: 'MERCADO', negId: n.id, playerId: p.id, title: `Negociação por ${p.name} expirou`,
        body: n.kind === 'VENDA' ? 'A oferta não foi respondida a tempo.' : 'Demorou demais: a outra parte desistiu.' });
    }
  }
  for (const m of humans) {
    const club = clubOf(room, m.clubId!);
    const active = activeSponsorships(room, club.id);
    const openSlots = new Set(room.negotiations!.filter((n) => n.status === 'ABERTA' && n.kind === 'PATROCINIO' && n.clubId === club.id).map((n) => n.slot));
    for (const slot of SLOTS) {
      if (openSlots.has(slot)) continue;
      const cur = active.find((s) => s.slot === slot);
      if (cur) {
        // contrato terminando: o patrocinador propõe renovar nas últimas rodadas
        if (cur.endSeason === room.season && room.round === last - 6) openSponsorOffer(room, club, slot, cur.sponsorId, true);
        continue;
      }
      // espaço livre: de vez em quando aparece interessado
      if (Math.random() < 0.15) {
        const busy = new Set(room.world.sponsorships.filter((s) => s.clubId === club.id).map((s) => s.sponsorId));
        const options = room.world.sponsors.filter((s) => s.slot === slot && s.minReputation <= club.reputation + 10 && !busy.has(s.id));
        if (options.length) openSponsorOffer(room, club, slot, options[Math.floor(Math.random() * options.length)].id, false);
      }
    }
    // lembrete de contratos de jogadores no meio da temporada
    if (room.round === Math.floor(last / 2)) {
      const pending = room.world.players.filter((p) => p.clubId === club.id && p.contractEnd === room.season
        && !room.negotiations!.some((n) => n.playerId === p.id && n.season === room.season && n.status !== 'ABERTA'));
      if (pending.length) sendToClub(room, club.id, { type: 'DIRETORIA', title: 'Contratos terminando',
        body: `${pending.length} jogador${pending.length > 1 ? 'es têm' : ' tem'} contrato até o fim desta temporada: ${pending.map((p) => p.name).join(', ')}. Quem não renovar sai de graça.` });
    }
  }
}

/** Mensagens do começo da temporada (e quando o técnico assume o clube). */
export function seasonStartMessages(room: Room, clubId: number) {
  const players = room.world.players.filter((p) => p.clubId === clubId && p.contractEnd === room.season)
    .sort((a, b) => overall(b) - overall(a));
  for (const p of players.slice(0, 6)) {
    sendToClub(room, clubId, { type: 'RENOVACAO', playerId: p.id, title: `Contrato de ${p.name} termina nesta temporada`,
      body: `${p.name} (${p.position}, ${p.age} anos, geral ${overall(p)}) ganha ${brl(p.weeklySalary)} por semana. Abra a negociação para renovar.` });
  }
  if (players.length > 6) sendToClub(room, clubId, { type: 'DIRETORIA', title: 'Outros contratos terminando',
    body: `Mais ${players.length - 6} jogadores têm contrato só até esta temporada: ${players.slice(6).map((p) => p.name).join(', ')}.` });
}

// ================================================= fim de temporada
/**
 * Contratos que terminaram: jogadores sem renovação saem (clubes da IA
 * renovam sozinhos), patrocínios vencidos acabam, elencos curtos são completados.
 * Chamado com room.season já na temporada NOVA.
 */
export function expireContracts(room: Room) {
  ensure(room);
  const humans = new Set(room.members.filter((m) => m.clubId !== null).map((m) => m.clubId!));
  const season = room.season;
  const diff = DIFFICULTY[room.settings.difficulty];
  const left = new Map<number, string[]>();
  for (const p of room.world.players) {
    if (p.clubId === null || p.contractEnd >= season) continue;
    if (!humans.has(p.clubId) || p.isYouth) {
      // IA (e base): renova automaticamente; jogador velho e fraco vai embora às vezes
      if (!humans.has(p.clubId) && p.age >= 34 && Math.random() < 0.5) { p.clubId = null; continue; }
      p.contractEnd = season + Math.round(rand(1, 3));
      if (!p.isYouth) p.weeklySalary = salaryFor(overall(p), diff.wageDemands);
      continue;
    }
    const club = p.clubId;
    (left.get(club) ?? left.set(club, []).get(club)!).push(p.name);
    p.clubId = null;
    p.contractEnd = season;
  }
  for (const [clubId, names] of left) {
    sendToClub(room, clubId, { type: 'CONTRATO', title: `${names.length} jogador${names.length > 1 ? 'es deixaram' : ' deixou'} o clube`,
      body: `Contrato encerrado sem renovação: ${names.join(', ')}.` });
  }
  // patrocínios vencidos
  const ended = room.world.sponsorships.filter((s) => s.endSeason < season);
  room.world.sponsorships = room.world.sponsorships.filter((s) => s.endSeason >= season);
  for (const s of ended) {
    const club = clubOf(room, s.clubId);
    const sp = room.world.sponsors.find((x) => x.id === s.sponsorId)!;
    if (humans.has(s.clubId)) {
      sendToClub(room, s.clubId, { type: 'PATROCINIO', title: `Contrato com ${sp.name} terminou`, body: `O espaço "${SLOT_LABEL[s.slot]}" está livre. Novas propostas devem chegar nas próximas rodadas.` });
    } else {
      // IA renova pelo valor justo atual
      const perRound = sponsorFair(room, club, s.slot);
      room.world.sponsorships.push({ ...s, perRound, bonusPerWin: winBonus(perRound), endSeason: season + Math.round(rand(0, 2)) });
    }
  }
  // elenco mínimo: a diretoria contrata agentes livres baratos
  for (const club of room.world.clubs) {
    const squad = room.world.players.filter((p) => p.clubId === club.id && !p.isYouth);
    const need = room.settings.rules.squadMin - squad.length;
    if (need <= 0) continue;
    const counts = (pos: string) => squad.filter((p) => p.position === pos).length;
    const free = room.world.players.filter((p) => p.clubId === null && !p.isYouth && p.age < 34)
      .sort((a, b) => overall(b) - overall(a));
    const signed: string[] = [];
    for (let i = 0; i < need && free.length; i++) {
      // prioriza a posição mais carente
      const pos = (['GOL', 'ZAG', 'LAT', 'VOL', 'MEI', 'ATA'] as const).map((x) => [x, counts(x) / ({ GOL: 2, ZAG: 4, LAT: 3, VOL: 3, MEI: 4, ATA: 3 }[x])] as const).sort((a, b) => a[1] - b[1])[0][0];
      const idx = Math.max(0, free.findIndex((p) => p.position === pos));
      const p = free.splice(idx, 1)[0];
      p.clubId = club.id; p.contractEnd = season + 1; p.weeklySalary = salaryFor(overall(p), diff.wageDemands);
      squad.push(p); signed.push(`${p.name} (${p.position}, geral ${overall(p)})`);
    }
    if (signed.length) sendToClub(room, club.id, { type: 'DIRETORIA', title: 'Diretoria completou o elenco',
      body: `O elenco estava abaixo do mínimo da sala. Foram contratados: ${signed.join(', ')}.` });
  }
  for (const m of room.members) if (m.clubId !== null) seasonStartMessages(room, m.clubId);
}

// ================================================================ views
export function negotiationView(room: Room, n: Negotiation) {
  const base = {
    id: n.id, tipo: n.kind, status: n.status, validaAte: n.expiresRound, unidade: unitOf(n.kind), valorUnico: ONE_OFF.includes(n.kind),
    paciencia: Math.max(0, n.patience), pacienciaMax: n.patienceMax, temporadasPreferidas: n.preferredSeasons,
    proposta: n.current, historico: n.history.map((h) => ({ de: h.from, texto: h.text, termos: h.terms })),
    maxTemporadas: n.kind === 'PATROCINIO' ? 3 : 5,
    outroClube: n.otherClubId ? { id: n.otherClubId, nome: clubOf(room, n.otherClubId).name } : null,
    passe: n.fee ?? null,
    proxima: (n as Negotiation & { next?: string }).next ?? null,
  };
  if (n.playerId) {
    const p = playerOf(room, n);
    return { ...base, jogador: { id: p.id, nome: p.name, pos: p.position, idade: p.age, ovr: overall(p), pot: p.potential,
      salario: p.weeklySalary, fimContrato: p.contractEnd, moral: p.morale, popularidade: p.popularity,
      clube: p.clubId !== null ? clubOf(room, p.clubId).name : null } };
  }
  const sp = room.world.sponsors.find((s) => s.id === n.sponsorId)!;
  const cur = activeSponsorships(room, n.clubId).find((s) => s.slot === n.slot);
  return { ...base, patrocinador: { id: sp.id, nome: sp.name }, espaco: n.slot, espacoNome: SLOT_LABEL[n.slot!], renovacao: !!n.renewal,
    bonusPorVitoria: winBonus(n.current.amount), contratoAtual: cur ? { valor: cur.perRound, ate: cur.endSeason } : null };
}

export function sponsorshipView(room: Room, clubId: number) {
  ensure(room);
  const last = lastRoundOf(room);
  return SLOTS.map((slot) => {
    const c = activeSponsorships(room, clubId).find((s) => s.slot === slot);
    const offer = room.negotiations!.find((n) => n.kind === 'PATROCINIO' && n.clubId === clubId && n.slot === slot && n.status === 'ABERTA');
    const sp = c && room.world.sponsors.find((s) => s.id === c.sponsorId);
    const roundsLeft = c ? (c.endSeason - room.season) * last + (last - room.round) : 0;
    return {
      espaco: slot, nome: SLOT_LABEL[slot],
      contrato: c ? { patrocinador: sp!.name, valor: c.perRound, bonus: c.bonusPerWin, ate: c.endSeason, multa: sponsorBreakFee(c.perRound, roundsLeft) } : null,
      proposta: offer ? { negId: offer.id, patrocinador: room.world.sponsors.find((s) => s.id === offer.sponsorId)!.name, valor: offer.current.amount } : null,
    };
  });
}
