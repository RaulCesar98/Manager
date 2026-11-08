// Empréstimos de jogadores.
//
// Um empréstimo leva o jogador para outro clube até o fim de uma temporada. O contrato
// continua com o clube dono; o que se negocia é:
//  - quem paga o salário (o clube que recebe paga 0%, 25%, 50%, 75% ou 100%; o dono paga o resto);
//  - uma taxa de empréstimo (opcional), paga na hora pelo clube que recebe;
//  - uma cláusula de compra com valor pré-fixado, que pode depender de uma meta
//    (jogos, gols ou nota média) e pode ser obrigatória (bateu a meta, a compra acontece
//    sozinha no fim do empréstimo) ou opcional (bateu a meta, o clube pode comprar quando quiser).
//
// Quem pode emprestar: técnico pede emprestado a um clube da IA (resposta na hora) ou a outro
// técnico (aceita ou recusa). Clubes da IA pedem emprestado os jogadores que o técnico marcou
// como disponíveis, e às vezes jovens que estão jogando pouco; o técnico aceita, recusa ou
// faz uma contraproposta.

import { overall } from '../sim/strength.ts';
import type { GenClub, GenPlayer } from '../sim/worldgen.ts';
import type { Room } from './engine.ts';
import { MIN_SQUAD_TO_SELL, currentValue, marketEnv, windowStatus } from './market.ts';
import { OfficeError, brl, ensure, lastRoundOf, rand, roundMoney, sendToClub } from './office.ts';

export type LoanGoal = 'NENHUMA' | 'JOGOS' | 'GOLS' | 'NOTA';
export interface BuyClause { price: number; goal: LoanGoal; target: number; mandatory: boolean }
export interface LoanTerms {
  until: number;            // termina no fim desta temporada
  share: number;            // % do salário pago pelo clube que recebe (0..100)
  fee: number;              // taxa de empréstimo (centavos)
  buy: BuyClause | null;
}
interface Stats { apps: number; goals: number; ratingSum: number }
export interface Loan {
  id: string; playerId: number; ownerId: number; borrowerId: number; terms: LoanTerms;
  startSeason: number; startRound: number;
  base: Stats;              // números da temporada quando o empréstimo começou
  acc: Stats;               // números de temporadas anteriores do mesmo empréstimo
  goalNotified?: boolean;
}
export interface LoanProposal {
  id: string; playerId: number; ownerId: number; borrowerId: number; proposerId: number;
  terms: LoanTerms; status: 'PENDENTE' | 'ACEITA' | 'RECUSADA' | 'CANCELADA' | 'EXPIRADA';
  season: number; round: number; expires: number; counters: number;
}

const SHARES = [0, 25, 50, 75, 100];
const MAX_TRIES = 3;                       // propostas recusadas por jogador e temporada
export const GOAL_LABEL: Record<LoanGoal, string> = { NENHUMA: 'Sem meta', JOGOS: 'Jogos', GOLS: 'Gols', NOTA: 'Nota média' };

// ================================================================ util
const clubOf = (room: Room, id: number) => room.world.clubs.find((c) => c.id === id)!;
const playerById = (room: Room, id: number) => room.world.players.find((p) => p.id === id);
const humans = (room: Room) => new Set(room.members.filter((m) => m.clubId !== null).map((m) => m.clubId!));
const squad = (room: Room, clubId: number) => room.world.players.filter((p) => p.clubId === clubId && !p.isYouth);

function ensureLoans(room: Room) {
  ensure(room);
  room.loans ??= [];
  room.loanProposals ??= [];
  room.loanListed ??= [];
  room.loanRefusals ??= {};
}
export const loanOf = (room: Room, playerId: number) => (room.loans ?? []).find((l) => l.playerId === playerId);

function roundsLeft(room: Room, until: number) {
  const last = lastRoundOf(room);
  return Math.max(1, (until - room.season) * last + (last - room.round));
}
/** Tolerância fixa por jogador e temporada (evita "pescar" o limite com propostas iguais). */
const tolerance = (room: Room, p: GenPlayer) => 0.92 + ((p.id * 13 + room.season * 7) % 17) / 100;

function book(room: Room, club: GenClub, label: string, amount: number) {
  if (!amount) return;
  club.balance += amount;
  const cs = room.clubs[club.id];
  const k = amount > 0 ? 'income' : 'expense';
  cs[k][label] = (cs[k][label] ?? 0) + Math.abs(amount);
  cs.lastRound[k][label] = (cs.lastRound[k][label] ?? 0) + Math.abs(amount);
}

// ============================================================ textos
function buyText(b: BuyClause) {
  const goal = b.goal === 'NENHUMA' ? '' : b.goal === 'NOTA' ? ` se ele tiver nota média ${b.target.toFixed(1)} ou mais (mínimo 5 jogos)`
    : ` se ele fizer ${b.target} ${b.goal === 'JOGOS' ? 'jogos' : 'gols'}`;
  return `${b.mandatory ? 'compra obrigatória' : 'opção de compra'} por ${brl(b.price)}${goal}`;
}
export function shareText(share: number) {
  return share === 100 ? 'quem recebe paga todo o salário' : share === 0 ? 'o dono continua pagando todo o salário' : `quem recebe paga ${share}% do salário e o dono ${100 - share}%`;
}
export function describeTerms(t: LoanTerms) {
  return [`até o fim da temporada ${t.until}`, shareText(t.share), t.fee ? `taxa de ${brl(t.fee)}` : 'sem taxa', t.buy ? buyText(t.buy) : 'sem cláusula de compra'].join('; ');
}

// ======================================================= condições
/** Lê as condições do formulário (valores em reais) e valida. */
export function parseTerms(room: Room, raw: Record<string, unknown>): LoanTerms {
  const last = lastRoundOf(room);
  const until = Number(raw.ate);
  const minUntil = room.round >= last ? room.season + 1 : room.season;
  if (!(until === room.season || until === room.season + 1) || until < minUntil) throw new OfficeError('Duração inválida: até o fim desta temporada ou da próxima.');
  const share = Number(raw.salario);
  if (!SHARES.includes(share)) throw new OfficeError('Escolha quanto do salário o clube que recebe vai pagar.');
  const fee = roundMoney(Math.max(0, Number(raw.taxa) || 0) * 100);
  let buy: BuyClause | null = null;
  const c = raw.compra as Record<string, unknown> | null | undefined;
  if (c) {
    const price = roundMoney(Number(c.valor) * 100);
    if (!(price > 0)) throw new OfficeError('Informe o valor da compra.');
    const goal = String(c.meta ?? 'NENHUMA') as LoanGoal;
    if (!GOAL_LABEL[goal]) throw new OfficeError('Meta inválida.');
    let target = Number(c.alvo) || 0;
    if (goal === 'JOGOS' && !(target >= 1 && target <= 60)) throw new OfficeError('A meta de jogos vai de 1 a 60.');
    if (goal === 'GOLS' && !(target >= 1 && target <= 40)) throw new OfficeError('A meta de gols vai de 1 a 40.');
    if (goal === 'NOTA' && !(target >= 5 && target <= 9.5)) throw new OfficeError('A meta de nota vai de 5,0 a 9,5.');
    target = goal === 'NOTA' ? Math.round(target * 10) / 10 : goal === 'NENHUMA' ? 0 : Math.round(target);
    buy = { price, goal, target, mandatory: !!c.obrigatoria };
  }
  return { until, share, fee, buy };
}

// ========================================================= progresso
export function loanProgress(room: Room, l: Loan) {
  const s = room.status[l.playerId];
  const apps = l.acc.apps + (s?.apps ?? 0) - l.base.apps;
  const goals = l.acc.goals + (s?.goals ?? 0) - l.base.goals;
  const ratingSum = l.acc.ratingSum + (s?.ratingSum ?? 0) - l.base.ratingSum;
  return { apps, goals, rating: apps ? Math.round((ratingSum / apps) * 10) / 10 : null };
}
export function goalMet(room: Room, l: Loan) {
  const b = l.terms.buy;
  if (!b) return false;
  const pr = loanProgress(room, l);
  if (b.goal === 'NENHUMA') return true;
  if (b.goal === 'JOGOS') return pr.apps >= b.target;
  if (b.goal === 'GOLS') return pr.goals >= b.target;
  return pr.apps >= 5 && (pr.rating ?? 0) >= b.target;
}

// ======================================================= avaliação da IA
interface Verdict { ok: boolean; hint: string }
const rankIn = (room: Room, p: GenPlayer, clubId: number) => squad(room, clubId).sort((a, b) => overall(b) - overall(a)).indexOf(p);

/** O clube dono (IA) aceita emprestar nessas condições? */
function ownerAccepts(room: Room, p: GenPlayer, owner: GenClub, borrower: GenClub, t: LoanTerms): Verdict {
  if (squad(room, owner.id).length - 1 < room.settings.rules.squadMin) return { ok: false, hint: `O ${owner.name} está com o elenco curto e não empresta ninguém agora.` };
  if (borrower.tier > owner.tier + 1) return { ok: false, hint: `${p.name} não aceita descer tanto de divisão.` };
  const value = currentValue(p), sal = p.weeklySalary, R = roundsLeft(room, t.until);
  const rank = rankIn(room, p, owner.id);
  const key = rank >= 0 && rank < 11;
  let reqShare = key ? 100 : rank < 18 ? 75 : 50;
  if (p.age <= 22) reqShare -= 25;                    // jovem precisa de minutos: o dono facilita
  reqShare = Math.max(0, reqShare);
  const required = sal * R * reqShare / 100 + (key ? value * 0.2 : 0);
  let offered = t.fee + sal * R * t.share / 100;
  if (t.buy) {
    if (t.buy.price < value * 0.85) return { ok: false, hint: `Valor de compra muito baixo: o ${owner.name} não vende ${p.name} por menos de ${brl(roundMoney(value))}.` };
    offered += (t.buy.price - value * 1.1) * (t.buy.mandatory ? 0.6 : 0.3);
  }
  if (offered >= required * tolerance(room, p)) return { ok: true, hint: '' };
  const hint = t.share < reqShare ? `O ${owner.name} quer que você pague pelo menos ${reqShare}% do salário, ou compense com uma taxa de empréstimo.`
    : t.buy && t.buy.price < value * 1.1 ? `O ${owner.name} acha o valor de compra baixo para ${p.name}.`
    : `O ${owner.name} quer uma taxa de empréstimo maior${key ? ` (${p.name} é titular)` : ''}.`;
  return { ok: false, hint };
}

/** O clube da IA aceita receber o jogador nessas condições? */
function borrowerAccepts(room: Room, p: GenPlayer, borrower: GenClub, t: LoanTerms): Verdict {
  if (squad(room, borrower.id).length >= room.settings.rules.squadMax) return { ok: false, hint: `O ${borrower.name} está com o elenco cheio.` };
  const value = currentValue(p), sal = p.weeklySalary, R = roundsLeft(room, t.until);
  const useful = overall(p) - borrower.level;
  if (useful < -12) return { ok: false, hint: `O ${borrower.name} acha que ${p.name} não tem nível para o elenco.` };
  const maxShare = useful >= -3 ? 100 : useful >= -8 ? 75 : 50;
  if (t.buy && t.buy.price > value * (t.buy.mandatory ? 1.2 : 1.5)) return { ok: false, hint: `O ${borrower.name} acha o valor de compra alto demais.` };
  const cost = t.fee + sal * R * t.share / 100;
  if (cost > Math.max(0, borrower.balance) * 0.5) return { ok: false, hint: `O ${borrower.name} não tem caixa para esse empréstimo.` };
  const budget = sal * R * maxShare / 100 + (useful >= 0 ? value * 0.05 : 0);
  if (cost <= budget * tolerance(room, p)) return { ok: true, hint: '' };
  return { ok: false, hint: t.share > maxShare ? `O ${borrower.name} paga no máximo ${maxShare}% do salário.` : `O ${borrower.name} acha a taxa de empréstimo alta.` };
}

// ================================================================ fechar
function newProposal(room: Room, o: Omit<LoanProposal, 'id' | 'status' | 'season' | 'round' | 'expires' | 'counters'>): LoanProposal {
  const prop: LoanProposal = { ...o, id: `emp${room.season}-${++room.msgSeq!}`, status: 'PENDENTE', season: room.season, round: room.round,
    expires: Math.min(lastRoundOf(room), room.round + 3), counters: 0 };
  room.loanProposals!.push(prop);
  if (room.loanProposals!.length > 300) room.loanProposals = room.loanProposals!.filter((x) => x.status === 'PENDENTE' || x.season === room.season);
  return prop;
}

/** Validações comuns antes de o jogador mudar de clube. */
function blocker(room: Room, p: GenPlayer, owner: GenClub, borrower: GenClub, t: LoanTerms): string | null {
  const w = windowStatus(room);
  if (!w.open) return w.text;
  if (p.clubId !== owner.id) return `${p.name} não está mais no ${owner.name}.`;
  if (loanOf(room, p.id)) return `${p.name} já está emprestado.`;
  if (p.contractEnd < t.until) return `O contrato de ${p.name} termina na temporada ${p.contractEnd}: o empréstimo não pode passar disso.`;
  if (squad(room, borrower.id).length >= room.settings.rules.squadMax) return `O elenco do ${borrower.name} já tem o máximo de ${room.settings.rules.squadMax} jogadores.`;
  const minOwner = humans(room).has(owner.id) ? MIN_SQUAD_TO_SELL : room.settings.rules.squadMin;
  if (squad(room, owner.id).length - 1 < minOwner) return `O elenco do ${owner.name} ficaria com menos de ${minOwner} jogadores.`;
  if (t.fee && room.settings.rules.blockSpendingWhenNegative && borrower.balance < t.fee) return `O ${borrower.name} não tem caixa para a taxa de ${brl(t.fee)}.`;
  return null;
}

function executeLoan(room: Room, prop: LoanProposal) {
  const p = playerById(room, prop.playerId)!;
  const owner = clubOf(room, prop.ownerId), borrower = clubOf(room, prop.borrowerId);
  const b = blocker(room, p, owner, borrower, prop.terms);
  if (b) throw new OfficeError(b);
  const t = prop.terms;
  if (t.fee) { book(room, borrower, 'Empréstimos', -t.fee); book(room, owner, 'Empréstimos', t.fee); }
  const s = room.status[p.id];
  const loan: Loan = {
    id: prop.id, playerId: p.id, ownerId: owner.id, borrowerId: borrower.id, terms: t, startSeason: room.season, startRound: room.round,
    base: { apps: s?.apps ?? 0, goals: s?.goals ?? 0, ratingSum: s?.ratingSum ?? 0 }, acc: { apps: 0, goals: 0, ratingSum: 0 },
  };
  p.clubId = borrower.id;
  p.morale = Math.min(100, p.morale + 5);
  room.loans!.push(loan);
  prop.status = 'ACEITA';
  // o que estava pendente para esse jogador cai
  room.forSale = (room.forSale ?? []).filter((l) => l.playerId !== p.id);
  room.loanListed = room.loanListed!.filter((id) => id !== p.id);
  for (const n of room.negotiations ?? []) if (n.playerId === p.id && n.status === 'ABERTA') n.status = 'EXPIRADA';
  for (const o of room.humanOffers ?? []) if (o.playerId === p.id && o.status === 'PENDENTE') o.status = 'CANCELADA';
  for (const x of room.loanProposals!) if (x !== prop && x.playerId === p.id && x.status === 'PENDENTE') x.status = 'CANCELADA';
  marketEnv.repairTactics?.(room, owner.id);
  marketEnv.repairTactics?.(room, borrower.id);
  const what = `${p.name} (${p.position}, geral ${overall(p)})`;
  const terms = describeTerms(t);
  sendToClub(room, borrower.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} chegou por empréstimo`,
    body: `${what} chega emprestado pelo ${owner.name}: ${terms}. Salário total de ${brl(p.weeklySalary)} por semana.` });
  sendToClub(room, owner.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} emprestado ao ${borrower.name}`,
    body: `${what} vai para o ${borrower.name}: ${terms}.${t.fee ? ` A taxa de ${brl(t.fee)} já entrou no caixa.` : ''}` });
  marketEnv.news?.(room, `Mercado: ${p.name} vai do ${owner.name} para o ${borrower.name} por empréstimo até o fim da temporada ${t.until}.`);
}

function completePurchase(room: Room, l: Loan, how: string) {
  const p = playerById(room, l.playerId)!;
  const owner = clubOf(room, l.ownerId), borrower = clubOf(room, l.borrowerId);
  const price = l.terms.buy!.price;
  book(room, borrower, 'Transferências', -price);
  book(room, owner, 'Transferências', price);
  room.loans = room.loans!.filter((x) => x !== l);
  p.clubId = borrower.id;
  p.contractEnd = Math.max(p.contractEnd, room.season + 2);
  sendToClub(room, borrower.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} comprado`,
    body: `${how} ${p.name} agora é do ${borrower.name} em definitivo, por ${brl(price)} pagos ao ${owner.name}. Contrato até a temporada ${p.contractEnd}, salário de ${brl(p.weeklySalary)} por semana (agora pago só pelo ${borrower.name}).` });
  sendToClub(room, owner.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} vendido ao ${borrower.name}`,
    body: `${how} O ${borrower.name} pagou ${brl(price)} e ${p.name} fica lá em definitivo.` });
  marketEnv.news?.(room, `Mercado: o ${borrower.name} compra ${p.name} do ${owner.name} (${brl(price)}) ao fim do empréstimo.`);
}

function returnPlayer(room: Room, l: Loan) {
  const p = playerById(room, l.playerId)!;
  const owner = clubOf(room, l.ownerId), borrower = clubOf(room, l.borrowerId);
  room.loans = room.loans!.filter((x) => x !== l);
  if (p.clubId === borrower.id) p.clubId = owner.id;
  marketEnv.repairTactics?.(room, owner.id);
  marketEnv.repairTactics?.(room, borrower.id);
  const pr = loanProgress(room, l);
  const line = `${pr.apps} jogos, ${pr.goals} gols${pr.rating ? `, nota média ${pr.rating}` : ''}`;
  sendToClub(room, owner.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} voltou de empréstimo`, body: `Fim do empréstimo ao ${borrower.name} (${line}). Ele está de volta ao elenco.` });
  sendToClub(room, borrower.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} voltou ao ${owner.name}`, body: `Terminou o empréstimo (${line}).` });
}

// ====================================================== ações do técnico
/** O técnico pede um jogador emprestado. */
export function proposeLoan(room: Room, myClubId: number, playerId: number, raw: Record<string, unknown>) {
  ensureLoans(room);
  const p = playerById(room, playerId);
  if (!p || p.isYouth || p.clubId === null) throw new OfficeError('Só dá para pedir emprestado jogador de outro clube.');
  if (p.clubId === myClubId) throw new OfficeError('Esse jogador já é seu.');
  const cur = loanOf(room, p.id);
  if (cur) throw new OfficeError(`${p.name} já está emprestado ao ${clubOf(room, cur.borrowerId).name}.`);
  const t = parseTerms(room, raw);
  const me = clubOf(room, myClubId), owner = clubOf(room, p.clubId);
  const b = blocker(room, p, owner, me, t);
  if (b) throw new OfficeError(b);
  if (room.loanProposals!.some((x) => x.playerId === p.id && x.borrowerId === myClubId && x.status === 'PENDENTE'))
    throw new OfficeError('Você já tem um pedido de empréstimo aguardando resposta por esse jogador.');
  const key = `${room.season}:${myClubId}:${p.id}`;
  const tries = room.loanRefusals![key] ?? 0;
  if (tries >= MAX_TRIES) throw new OfficeError(`O ${owner.name} não quer mais conversar sobre empréstimo de ${p.name} nesta temporada.`);
  const prop = newProposal(room, { playerId: p.id, ownerId: owner.id, borrowerId: me.id, proposerId: me.id, terms: t });

  if (humans(room).has(owner.id)) {
    sendToClub(room, owner.id, { type: 'MERCADO', loanId: prop.id, playerId: p.id, title: `${me.name} pede ${p.name} emprestado`,
      body: `O ${me.name} quer ${p.name} emprestado: ${describeTerms(t)}. Responda até a rodada ${prop.expires}.` });
    return { status: 'PENDENTE', texto: `Pedido enviado ao técnico do ${owner.name}. A resposta chega pela caixa de mensagens.` };
  }
  const v = ownerAccepts(room, p, owner, me, t);
  if (v.ok) { executeLoan(room, prop); return { status: 'ACEITA', texto: `O ${owner.name} aceitou! ${p.name} já está no seu elenco.` }; }
  prop.status = 'RECUSADA';
  room.loanRefusals![key] = tries + 1;
  const left = MAX_TRIES - tries - 1;
  return { status: 'RECUSADA', texto: `${v.hint} ${left ? `Você ainda pode tentar ${left} vez${left > 1 ? 'es' : ''} nesta temporada.` : 'Eles encerraram a conversa nesta temporada.'}` };
}

/** Resposta do dono do jogador a um pedido de empréstimo. */
export function answerLoan(room: Room, myClubId: number, propId: string, action: 'ACEITAR' | 'RECUSAR' | 'CONTRA', raw?: Record<string, unknown>) {
  ensureLoans(room);
  const prop = room.loanProposals!.find((x) => x.id === propId && x.ownerId === myClubId);
  if (!prop) throw new OfficeError('Pedido de empréstimo não encontrado.');
  if (prop.status !== 'PENDENTE') throw new OfficeError('Esse pedido já foi respondido ou expirou.');
  const p = playerById(room, prop.playerId)!;
  const borrower = clubOf(room, prop.borrowerId), me = clubOf(room, myClubId);
  if (p.clubId !== myClubId) { prop.status = 'CANCELADA'; throw new OfficeError('Esse jogador não está mais no seu elenco.'); }
  const fromHuman = humans(room).has(prop.proposerId);
  if (action === 'RECUSAR') {
    prop.status = 'RECUSADA';
    if (fromHuman) sendToClub(room, prop.proposerId, { type: 'MERCADO', playerId: p.id, title: `${me.name} recusou o empréstimo`, body: `O pedido de empréstimo de ${p.name} foi recusado.` });
    return { status: 'RECUSADA', texto: 'Pedido recusado.' };
  }
  if (action === 'ACEITAR') {
    executeLoan(room, prop);
    return { status: 'ACEITA', texto: `${p.name} foi emprestado ao ${borrower.name}.` };
  }
  // contraproposta: só com clube da IA, que responde na hora
  if (fromHuman) throw new OfficeError('Com outro técnico não há contraproposta: recuse e combine novas condições com ele.');
  const t = parseTerms(room, raw ?? {});
  const b = blocker(room, p, me, borrower, t);
  if (b) throw new OfficeError(b);
  const v = borrowerAccepts(room, p, borrower, t);
  if (v.ok) { prop.terms = t; executeLoan(room, prop); return { status: 'ACEITA', texto: `O ${borrower.name} aceitou suas condições. ${p.name} foi emprestado.` }; }
  prop.counters++;
  if (prop.counters >= 2) { prop.status = 'RECUSADA'; return { status: 'RECUSADA', texto: `${v.hint} O ${borrower.name} desistiu do empréstimo.` }; }
  return { status: 'PENDENTE', texto: `${v.hint} Você pode tentar mais uma contraproposta ou aceitar as condições originais.` };
}

/** Marca (ou desmarca) um jogador do elenco como disponível para empréstimo. */
export function setLoanListed(room: Room, clubId: number, playerId: number, on: boolean) {
  ensureLoans(room);
  const p = playerById(room, playerId);
  if (!p || p.clubId !== clubId || p.isYouth) throw new OfficeError('Esse jogador não é do seu elenco profissional.');
  if (loanOf(room, p.id)) throw new OfficeError('Esse jogador já está emprestado.');
  room.loanListed = room.loanListed!.filter((id) => id !== playerId);
  if (on) room.loanListed!.push(playerId);
  return on;
}

/** O clube que recebeu exerce a opção de compra. */
export function exerciseBuy(room: Room, myClubId: number, loanId: string) {
  ensureLoans(room);
  const l = room.loans!.find((x) => x.id === loanId && x.borrowerId === myClubId);
  if (!l) throw new OfficeError('Empréstimo não encontrado.');
  if (!l.terms.buy) throw new OfficeError('Esse empréstimo não tem cláusula de compra.');
  if (!goalMet(room, l)) throw new OfficeError('A meta da cláusula de compra ainda não foi batida.');
  const me = clubOf(room, myClubId);
  if (room.settings.rules.blockSpendingWhenNegative && me.balance < l.terms.buy.price) throw new OfficeError(`Caixa insuficiente para pagar ${brl(l.terms.buy.price)}.`);
  completePurchase(room, l, 'Opção de compra exercida.');
}

// ====================================================== a cada rodada
/** Parte do salário que cada clube paga a mais (dono) ou a menos (quem recebe). */
export function loanWageDelta(room: Room, clubId: number) {
  let d = 0;
  for (const l of room.loans ?? []) {
    if (l.ownerId !== clubId && l.borrowerId !== clubId) continue;
    const p = playerById(room, l.playerId);
    if (!p) continue;
    const part = Math.round(p.weeklySalary * (100 - l.terms.share) / 100);
    if (l.ownerId === clubId) d += part;
    if (l.borrowerId === clubId) d -= part;
  }
  return d;
}

function aiLoanOffer(room: Room, p: GenPlayer) {
  const owner = clubOf(room, p.clubId!);
  const H = humans(room), ovr = overall(p), last = lastRoundOf(room);
  const until = room.round >= last - 4 ? room.season + 1 : room.season;
  if (p.contractEnd < until) return;
  const busy = new Set(room.loanProposals!.filter((x) => x.playerId === p.id && x.status === 'PENDENTE').map((x) => x.borrowerId));
  const options = room.world.clubs.filter((c) => !H.has(c.id) && !busy.has(c.id) && c.tier >= owner.tier && c.tier <= owner.tier + 1
    && ovr - c.level >= -10 && ovr - c.level <= 6 && squad(room, c.id).length < room.settings.rules.squadMax - 1 && c.balance > 0);
  if (!options.length) return;
  const b = options[Math.floor(Math.random() * options.length)];
  const value = currentValue(p);
  const useful = ovr - b.level;
  const share = useful >= -3 ? [100, 75][Math.floor(Math.random() * 2)] : [75, 50][Math.floor(Math.random() * 2)];
  const fee = Math.random() < 0.3 ? roundMoney(value * rand(0.02, 0.08)) : 0;
  let buy: BuyClause | null = null;
  if (Math.random() < 0.45) {
    const mandatory = Math.random() < 0.35;
    const R = roundsLeft(room, until);
    const goals = ['JOGOS', 'NOTA', 'NENHUMA', ...(['ATA', 'MEI'].includes(p.position) ? ['GOLS', 'GOLS'] : [])] as LoanGoal[];
    const goal = goals[Math.floor(Math.random() * goals.length)];
    const target = goal === 'JOGOS' ? Math.max(3, Math.round(R * rand(0.35, 0.6)))
      : goal === 'GOLS' ? Math.max(1, Math.round(R * (p.position === 'ATA' ? rand(0.25, 0.45) : rand(0.1, 0.2))))
      : goal === 'NOTA' ? Math.round(rand(6.5, 7.2) * 10) / 10 : 0;
    buy = { price: roundMoney(value * (mandatory ? rand(1.05, 1.2) : rand(1.15, 1.45))), goal, target, mandatory };
  }
  const prop = newProposal(room, { playerId: p.id, ownerId: owner.id, borrowerId: b.id, proposerId: b.id, terms: { until, share, fee, buy } });
  sendToClub(room, owner.id, { type: 'MERCADO', loanId: prop.id, playerId: p.id, title: `Pedido de empréstimo: ${p.name}`,
    body: `O ${b.name} quer ${p.name} emprestado: ${describeTerms(prop.terms)}. Aceite, recuse ou faça uma contraproposta até a rodada ${prop.expires}.` });
}

export function loansAfterRound(room: Room) {
  ensureLoans(room);
  const H = humans(room);
  // pedidos que caducaram
  for (const x of room.loanProposals!) {
    if (x.status !== 'PENDENTE' || room.round <= x.expires) continue;
    x.status = 'EXPIRADA';
    const p = playerById(room, x.playerId);
    if (p && H.has(x.proposerId) && x.proposerId !== x.ownerId) sendToClub(room, x.proposerId, { type: 'MERCADO', playerId: p.id, title: `Pedido de empréstimo de ${p.name} expirou`, body: `O ${clubOf(room, x.ownerId).name} não respondeu a tempo.` });
  }
  // meta da cláusula de compra batida
  for (const l of room.loans!) {
    if (!l.terms.buy || l.goalNotified || !goalMet(room, l)) continue;
    l.goalNotified = true;
    const p = playerById(room, l.playerId)!, b = l.terms.buy;
    const owner = clubOf(room, l.ownerId), borrower = clubOf(room, l.borrowerId);
    const body = b.mandatory
      ? `${p.name} bateu a meta (${GOAL_LABEL[b.goal].toLowerCase()}). A compra por ${brl(b.price)} é obrigatória e acontece no fim do empréstimo.`
      : `${p.name} bateu a meta (${GOAL_LABEL[b.goal].toLowerCase()}). O ${borrower.name} já pode comprá-lo por ${brl(b.price)}.`;
    if (b.goal !== 'NENHUMA') {
      sendToClub(room, borrower.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} bateu a meta do empréstimo`, body: body + (b.mandatory ? '' : ' Use o botão na ficha do jogador ou no quadro de empréstimos do Mercado.') });
      sendToClub(room, owner.id, { type: 'MERCADO', playerId: p.id, title: `${p.name} bateu a meta no ${borrower.name}`, body });
    }
  }
  if (!windowStatus(room).open) return;
  // clubes da IA pedem emprestado
  const pending = new Set(room.loanProposals!.filter((x) => x.status === 'PENDENTE').map((x) => x.playerId));
  for (const clubId of H) {
    const mine = squad(room, clubId).filter((p) => !loanOf(room, p.id) && !pending.has(p.id));
    for (const p of mine.filter((x) => room.loanListed!.includes(x.id))) if (Math.random() < 0.5) aiLoanOffer(room, p);
    // às vezes um jovem que está jogando pouco também desperta interesse
    if (Math.random() < 0.12) {
      const benched = mine.filter((p) => p.age <= 23 && !room.loanListed!.includes(p.id) && (room.status[p.id]?.apps ?? 0) <= room.round * 0.3);
      if (benched.length) aiLoanOffer(room, benched[Math.floor(Math.random() * benched.length)]);
    }
  }
}

/** Fim da temporada (antes de zerar as estatísticas): empréstimos que terminam. */
export function loansSeasonEnd(room: Room) {
  ensureLoans(room);
  for (const l of [...room.loans!]) {
    if (l.terms.until > room.season) {
      // continua na próxima temporada: guarda os números desta
      const s = room.status[l.playerId];
      l.acc.apps += (s?.apps ?? 0) - l.base.apps; l.acc.goals += (s?.goals ?? 0) - l.base.goals; l.acc.ratingSum += (s?.ratingSum ?? 0) - l.base.ratingSum;
      l.base = { apps: 0, goals: 0, ratingSum: 0 };
      continue;
    }
    const b = l.terms.buy;
    if (b && goalMet(room, l)) {
      const borrower = clubOf(room, l.borrowerId);
      const p = playerById(room, l.playerId)!;
      if (b.mandatory) { completePurchase(room, l, 'Compra obrigatória por meta batida.'); continue; }
      const aiBuys = !humans(room).has(borrower.id) && b.price <= currentValue(p) * 1.35 && borrower.balance > b.price * 0.8;
      if (aiBuys) { completePurchase(room, l, 'O clube exerceu a opção de compra.'); continue; }
    }
    returnPlayer(room, l);
  }
  for (const x of room.loanProposals!) if (x.status === 'PENDENTE') x.status = 'EXPIRADA';
  room.loanRefusals = {};
}

// ================================================================ views
function loanRow(room: Room, l: Loan, clubId: number) {
  const p = playerById(room, l.playerId)!;
  const met = goalMet(room, l);
  const b = l.terms.buy;
  return {
    id: l.id, jogador: { id: p.id, nome: p.name, pos: p.position, idade: p.age, ovr: overall(p) },
    dono: clubOf(room, l.ownerId).name, recebe: clubOf(room, l.borrowerId).name, ate: l.terms.until,
    salario: p.weeklySalary, porcentagemRecebe: l.terms.share, taxa: l.terms.fee,
    vocePaga: Math.round(p.weeklySalary * (l.ownerId === clubId ? 100 - l.terms.share : l.terms.share) / 100),
    termos: describeTerms(l.terms), progresso: loanProgress(room, l),
    compra: b ? { valor: b.price, meta: b.goal, metaNome: GOAL_LABEL[b.goal], alvo: b.target, obrigatoria: b.mandatory, batida: met, texto: buyText(b) } : null,
    podeComprar: !!b && met && l.borrowerId === clubId,
  };
}

export function loansView(room: Room, clubId: number) {
  ensureLoans(room);
  const H = humans(room);
  return {
    janela: windowStatus(room),
    temporada: room.season, ultimaRodada: room.round >= lastRoundOf(room),
    cedidos: room.loans!.filter((l) => l.ownerId === clubId).map((l) => loanRow(room, l, clubId)),
    recebidos: room.loans!.filter((l) => l.borrowerId === clubId).map((l) => loanRow(room, l, clubId)),
    propostas: room.loanProposals!.filter((x) => x.status === 'PENDENTE' && (x.ownerId === clubId || x.proposerId === clubId)).map((x) => {
      const p = playerById(room, x.playerId)!;
      return {
        id: x.id, jogador: { id: p.id, nome: p.name, pos: p.position, idade: p.age, ovr: overall(p), salario: p.weeklySalary, valor: currentValue(p) },
        dono: clubOf(room, x.ownerId).name, recebe: clubOf(room, x.borrowerId).name, termos: describeTerms(x.terms), validaAte: x.expires,
        recebida: x.ownerId === clubId, deTecnico: H.has(x.proposerId),
        condicoes: { ate: x.terms.until, salario: x.terms.share, taxa: x.terms.fee / 100,
          compra: x.terms.buy ? { valor: x.terms.buy.price / 100, meta: x.terms.buy.goal, alvo: x.terms.buy.target, obrigatoria: x.terms.buy.mandatory } : null },
      };
    }),
    disponiveis: room.loanListed!.map((id) => playerById(room, id)).filter((p): p is GenPlayer => !!p && p.clubId === clubId)
      .map((p) => ({ id: p.id, nome: p.name, pos: p.position, ovr: overall(p) })),
  };
}

/** Informações de empréstimo para a ficha do jogador. */
export function playerLoanInfo(room: Room, myClubId: number, playerId: number) {
  ensureLoans(room);
  const l = loanOf(room, playerId);
  const p = playerById(room, playerId);
  return {
    emprestimo: l ? { ...loanRow(room, l, myClubId), souDono: l.ownerId === myClubId, souRecebedor: l.borrowerId === myClubId } : null,
    disponivelEmprestimo: room.loanListed!.includes(playerId),
    pedidoEmprestimo: room.loanProposals!.some((x) => x.playerId === playerId && x.borrowerId === myClubId && x.status === 'PENDENTE'),
    contratoAte: p?.contractEnd ?? null,
    temporada: room.season, ultimaRodada: room.round >= lastRoundOf(room),
  };
}
