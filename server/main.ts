// Servidor do jogo — sem dependências, só Node 22.6+ (ou 24).
//   node --experimental-strip-types server/main.ts          (porta 3000)
//   PORT=8080 node --experimental-strip-types server/main.ts
// Serve as páginas de web/ e a API em /api. As salas ficam em dados/.

import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { CAMPAIGNS, type CampaignKind } from '../sim/fans.ts';
import type { RoomSettings } from '../sim/settings.ts';
import { overall, positionFactor, roleRating } from '../sim/strength.ts';
import { leadership } from '../sim/match.ts';
import {
  BENCH_SIZE, FORMATIONS, GameError, activeCampaigns, autoTactics, clubById, createRoom, freeClubs,
  joinRoom, lastRound, liveAction, liveSims, liveTick, normalizeRoom, pickClub, readiness, seasonOver, setReady, setTactics, squadOf, standings, startCampaign,
  statusOf, stopCampaign, tick, type Mentality, type Room,
} from './engine.ts';
import {
  OfficeError, breakSponsorship, canRenew, inboxOf, markRead, negotiate, negotiationView, openRenewal, sponsorshipView,
} from './office.ts';
import type { SponsorSlot } from '../sim/fans.ts';
import { cancelProject, extraIntake, gatePreview, promoteYouth, releaseYouth, setTicketPrices, stadiumView, startProject, youthView } from './club.ts';
import { answerHumanOffer, currentValue, listingPrice, playerDetail, searchPlayers, setForSale, startInterest, type SearchFilters } from './market.ts';
import {
  allRooms, checkPassword, createSession, createUser, dataDir, deleteSession, findUser, hashPassword,
  newId, roomByCode, roomById, saveRoom, sessionUser, type User,
} from './store.ts';

const PORT = Number(process.env.PORT ?? 3000);
const WEB_DIR = resolve(process.cwd(), 'web');

// ============================================================ helpers
class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'Requisição grande demais.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'JSON inválido.'); }
}

function cookie(req: IncomingMessage, name: string) {
  const m = (req.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : undefined;
}
const sessionCookie = (token: string, maxAge: number) =>
  `sessao=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

function requireUser(req: IncomingMessage): User {
  const u = sessionUser(cookie(req, 'sessao'));
  if (!u) throw new HttpError(401, 'Entre na sua conta.');
  return u;
}
function requireMember(room: Room | undefined, user: User) {
  if (!room) throw new HttpError(404, 'Sala não encontrada.');
  const m = room.members.find((x) => x.userId === user.id);
  if (!m) throw new HttpError(403, 'Você não está nesta sala.');
  return m;
}
function requireClub(room: Room, user: User): number {
  const m = requireMember(room, user);
  if (m.clubId === null) throw new HttpError(400, 'Escolha um clube primeiro.');
  return m.clubId;
}

const avgTop11 = (room: Room, clubId: number) => Math.round(
  squadOf(room, clubId).map(overall).sort((a, b) => b - a).slice(0, 11).reduce((s, x) => s + x, 0) / 11);
const clubRef = (room: Room, id: number) => { const c = clubById(room, id); return { id, nome: c.name, sigla: c.shortName }; };
const tierName = (room: Room, t: number) => room.world.divisions.find((d) => d.tier === t)?.name ?? `Divisão ${t}`;

// ============================================================== views
function roomListItem(room: Room, userId: string) {
  const m = room.members.find((x) => x.userId === userId)!;
  return {
    id: room.id, nome: room.name, codigo: room.code, temporada: room.season, rodada: room.round,
    totalRodadas: lastRound(room), solo: room.settings.maxHumans === 1,
    humanos: room.members.length, max: room.settings.maxHumans,
    clube: m.clubId !== null ? clubRef(room, m.clubId) : null,
    prontoParaJogar: m.clubId !== null && !room.ready.includes(userId),
  };
}

/** Últimos resultados de um clube (mais recente por último). */
function formOf(room: Room, clubId: number, n = 5) {
  return room.results.filter((r) => r.homeId === clubId || r.awayId === clubId).slice(-n).map((r) => {
    const home = r.homeId === clubId, gf = home ? r.hg : r.ag, ga = home ? r.ag : r.hg;
    return { r: gf > ga ? 'V' : gf === ga ? 'E' : 'D', gp: gf, gc: ga, rodada: r.round, casa: home, adversario: clubRef(room, home ? r.awayId : r.homeId).sigla };
  });
}

/** Tudo o que o painel inicial mostra além do básico. */
function dashboardView(room: Room, user: User, clubId: number) {
  const club = clubById(room, clubId);
  const cs = room.clubs[clubId];
  const table = standings(room, club.tier);
  const posOf = (id: number) => table.findIndex((r) => r.clubId === id) + 1;
  const myPos = posOf(clubId);
  const start = Math.max(0, Math.min(table.length - 5, myPos - 3));
  const { promotion, relegation, divisions } = room.settings.structure;
  const squad = squadOf(room, clubId);
  const st = (id: number) => room.status[id];
  const t = room.tactics[clubId];
  const cap = t?.captainId ? squad.find((p) => p.id === t.captainId) : undefined;
  const scorer = [...squad].sort((a, b) => (st(b.id)?.goals ?? 0) - (st(a.id)?.goals ?? 0))[0];
  const rated = squad.filter((p) => (st(p.id)?.apps ?? 0) >= Math.max(1, Math.ceil(room.round * 0.4)))
    .sort((a, b) => st(b.id)!.ratingSum / st(b.id)!.apps - st(a.id)!.ratingSum / st(a.id)!.apps)[0];
  const next = room.world.fixtures.find((f) => f.round === room.round + 1 && (f.homeId === clubId || f.awayId === clubId));
  const opp = next ? (next.homeId === clubId ? next.awayId : next.homeId) : null;
  const hist = cs.fanHistory;
  const inc = Object.values(cs.lastRound.income).reduce((a, b) => a + b, 0), exp = Object.values(cs.lastRound.expense).reduce((a, b) => a + b, 0);
  let aoVivo = null;
  if (room.live) {
    const { sims, fixtures } = liveSims(room);
    const i = fixtures.findIndex((f) => f.homeId === clubId || f.awayId === clubId);
    if (i >= 0) {
      sims[i].stepTo(liveTick(room));
      aoVivo = { mandante: clubRef(room, fixtures[i].homeId), visitante: clubRef(room, fixtures[i].awayId), gm: sims[i].score.home, gv: sims[i].score.away, relogio: sims[i].clock() };
    }
  }
  return {
    forma: formOf(room, clubId),
    proximo: next && opp ? {
      classico: club.rivalId === opp || clubById(room, opp).rivalId === clubId,
      estadio: clubById(room, next.homeId).stadiumName,
      posicaoAdversario: posOf(opp), formaAdversario: formOf(room, opp),
      meuPosicao: myPos,
    } : null,
    miniTabela: table.slice(start, start + 5).map((r, i) => ({
      pos: start + i + 1, clubId: r.clubId, nome: r.name, sigla: r.shortName, pts: r.pts, j: r.played, sg: r.gd, eu: r.clubId === clubId,
      zona: club.tier > 1 && start + i < promotion ? 'sobe' : club.tier < divisions && start + i >= table.length - relegation ? 'cai' : club.tier === 1 && start + i === 0 ? 'lider' : null,
    })),
    elenco: {
      total: squad.length,
      lesionados: squad.filter((p) => st(p.id)?.injured).map((p) => ({ nome: p.name, rodadas: st(p.id)!.injured })),
      suspensos: squad.filter((p) => st(p.id)?.suspended).map((p) => p.name),
      cansados: squad.filter((p) => p.fitness < 75 && t?.lineup.includes(p.id)).map((p) => ({ nome: p.name, cond: Math.round(p.fitness) })),
      contratosAcabando: squad.filter((p) => p.contractEnd <= room.season).length,
      aVenda: squad.filter((p) => listingPrice(room, p.id) !== null).length,
      capitao: cap ? { nome: cap.name, lideranca: Math.round(leadership(cap) * 100) } : null,
      artilheiro: scorer && st(scorer.id)?.goals ? { nome: scorer.name, gols: st(scorer.id).goals } : null,
      destaque: rated ? { nome: rated.name, nota: Math.round(st(rated.id)!.ratingSum / st(rated.id)!.apps * 10) / 10 } : null,
      folha: squad.reduce((a, p) => a + p.weeklySalary, 0),
    },
    financas: { saldoRodada: inc - exp, torcidaVariacao: hist.length > 1 ? hist[hist.length - 1] - hist[hist.length - 2] : 0 },
    mensagens: inboxOf(room, user.id).filter((m) => !m.read).slice(0, 3).map((m) => ({ id: m.id, tipo: m.type, titulo: m.title })),
    aoVivo,
  };
}

function stateView(room: Room, user: User) {
  const me = requireMember(room, user);
  const now = Date.now();
  const r = readiness(room, now);
  const myClub = me.clubId !== null ? clubById(room, me.clubId) : null;
  const next = myClub ? room.world.fixtures.find((f) => f.round === room.round + 1 && (f.homeId === myClub.id || f.awayId === myClub.id)) : undefined;
  const last = myClub ? room.results.find((r) => r.round === room.round && (r.homeId === myClub.id || r.awayId === myClub.id)) : undefined;
  const cs = myClub ? room.clubs[myClub.id] : null;
  const table = myClub ? standings(room, myClub.tier) : [];
  const pos = myClub ? table.findIndex((r) => r.clubId === myClub.id) + 1 : 0;
  return {
    agora: now,
    sala: {
      id: room.id, nome: room.name, codigo: room.code, dono: room.ownerId === user.id,
      solo: room.settings.maxHumans === 1, settings: room.settings,
      temporada: room.season, rodada: room.round, totalRodadas: lastRound(room),
      divisoes: room.world.divisions.map((x) => ({ tier: x.tier, nome: x.name })),
      temporadaEncerrada: seasonOver(room),
      regras: { sobem: room.settings.structure.promotion, descem: room.settings.structure.relegation, divisoes: room.settings.structure.divisions },
      ultimaRodadaEm: room.lastRunAt,
    },
    eu: { clubeId: me.clubId, pronto: room.ready.includes(user.id), afk: me.afk },
    aoVivo: room.live ? { rodada: room.live.round } : null,
    painel: me.clubId !== null ? dashboardView(room, user, me.clubId) : null,
    mensagensNaoLidas: inboxOf(room, user.id).filter((x) => !x.read).length,
    membros: room.members.map((m) => ({
      nome: m.username, clube: m.clubId !== null ? clubRef(room, m.clubId) : null,
      pronto: room.ready.includes(m.userId), afk: m.afk, eu: m.userId === user.id,
    })),
    espera: {
      faltam: room.members.filter((m) => r.waitingFor.includes(m.userId)).map((m) => m.username),
      prazo: r.deadline,
      esperaMinimaAte: r.minPrepEndsAt > now ? r.minPrepEndsAt : null,
      aoVivoAte: room.prepStartedAt > now ? room.prepStartedAt : null,
    },
    clube: myClub && cs ? {
      id: myClub.id, nome: myClub.name, sigla: myClub.shortName, divisao: myClub.tier, divisaoNome: tierName(room, myClub.tier),
      cidade: room.world.cities.find((c) => c.id === myClub.cityId)?.name, estadio: myClub.stadiumName,
      caixa: myClub.balance, torcida: myClub.fanBase, humor: myClub.fanMood, socios: cs.members,
      reputacao: myClub.reputation, posicao: pos, pontos: cs.pts, forca: avgTop11(room, myClub.id),
      campanha: { v: cs.w, e: cs.d, d: cs.l, gp: cs.gf, gc: cs.ga },
    } : null,
    proximoJogo: next ? {
      rodada: next.round, casa: next.homeId === myClub!.id,
      mandante: { ...clubRef(room, next.homeId), forca: avgTop11(room, next.homeId) },
      visitante: { ...clubRef(room, next.awayId), forca: avgTop11(room, next.awayId) },
    } : null,
    ultimoJogo: last ? { rodada: last.round, mandante: clubRef(room, last.homeId), visitante: clubRef(room, last.awayId), gm: last.hg, gv: last.ag } : null,
    noticias: room.news.slice(0, 12),
    ultimaTemporada: room.round <= 3 && room.lastSeason ? {
      temporada: room.lastSeason.season,
      campeoes: room.lastSeason.champions.map((id, i) => ({ divisao: room.lastSeason!.tables[i].name, clube: clubRef(room, id) })),
      subiram: room.lastSeason.promoted.map((id) => clubRef(room, id)),
      cairam: room.lastSeason.relegated.map((id) => clubRef(room, id)),
    } : null,
    historico: room.history,
  };
}

function squadView(room: Room, clubId: number) {
  const players = squadOf(room, clubId);
  return {
    temporada: room.season, formacoes: FORMATIONS, reservas: BENCH_SIZE, tatica: room.tactics[clubId] ?? autoTactics(room, clubId, '4-4-2', 0),
    jogadores: players.map((p) => {
      const s = statusOf(room, p.id);
      return {
        id: p.id, nome: p.name, idade: p.age, pos: p.position, ovr: overall(p), pot: p.potential,
        attrs: p.attrs, cond: Math.round(p.fitness), forma: p.form, moral: p.morale,
        lesao: s.injured, suspenso: s.suspended, amarelos: s.yellows,
        gols: s.goals, jogos: s.apps, nota: s.apps ? Math.round((s.ratingSum / s.apps) * 10) / 10 : null,
        salario: p.weeklySalary, valor: currentValue(p), fimContrato: p.contractEnd,
        podeRenovar: canRenew(room, p),
        negociacao: (room.negotiations ?? []).find((n) => n.playerId === p.id && n.status === 'ABERTA')?.id ?? null,
        recusouRenovar: (room.negotiations ?? []).some((n) => n.playerId === p.id && n.season === room.season && n.status === 'RECUSADA'),
        aVenda: listingPrice(room, p.id),
        lideranca: Math.round(leadership(p) * 100),
      };
    }).sort((a, b) => 'GOLZAGLATVOLMEIATA'.indexOf(a.pos) - 'GOLZAGLATVOLMEIATA'.indexOf(b.pos) || b.ovr - a.ovr),
  };
}

function roundView(room: Room, round: number, myClubId: number | null) {
  const games = room.results.filter((r) => r.round === round);
  const names = new Map(room.world.players.map((p) => [p.id, p.name]));
  const mine = games.find((g) => g.homeId === myClubId || g.awayId === myClubId);
  return {
    rodada: round, temporada: room.season, velocidade: room.settings.matchSpeed,
    jogos: games.map((g) => ({
      divisao: g.tier, divisaoNome: tierName(room, g.tier), mandante: clubRef(room, g.homeId), visitante: clubRef(room, g.awayId),
      gm: g.hg, gv: g.ag, publico: g.attendance, meu: g === mine,
    })),
    meuJogo: mine ? {
      mandante: clubRef(room, mine.homeId), visitante: clubRef(room, mine.awayId), gm: mine.hg, gv: mine.ag,
      publico: mine.attendance, renda: mine.revenue,
      posseMandante: mine.possessionHome, chutesMandante: mine.shotsHome, chutesVisitante: mine.shotsAway,
      eventos: (mine.events ?? []).map((e) => ({ ...e, jogador: e.playerId ? names.get(e.playerId) : undefined })),
      notas: (mine.ratings ?? []).map((r) => ({ ...r, nome: names.get(r.playerId) })).sort((a, b) => b.rating - a.rating),
    } : null,
  };
}

function financeView(room: Room, clubId: number) {
  const club = clubById(room, clubId);
  const cs = room.clubs[clubId];
  const active = activeCampaigns(room, clubId, room.round + 1);
  return {
    caixa: club.balance, torcida: club.fanBase, humor: club.fanMood, socios: cs.members,
    receitas: cs.income, despesas: cs.expense, ultimaRodada: cs.lastRound,
    historicoTorcida: cs.fanHistory,
    campanhas: (Object.keys(CAMPAIGNS) as CampaignKind[]).map((k) => {
      const c = CAMPAIGNS[k];
      const ativa = cs.campaigns.find((x) => x.kind === k);
      return {
        tipo: k, nome: c.label, descricao: c.description, duracao: c.durationRounds,
        custoPorRodada: c.costPerRound(club.fanBase), ativa: !!ativa && active.includes(k),
        ate: ativa?.untilRound ?? null,
      };
    }),
  };
}

function liveView(room: Room, myClubId: number | null) {
  if (!room.live) return { aoVivo: false, rodada: room.round, temporada: room.season };
  const { sims, fixtures } = liveSims(room);
  const t = liveTick(room);
  for (const x of sims) x.stepTo(t);
  const byId = new Map(room.world.players.map((p) => [p.id, p]));
  const mineIdx = fixtures.findIndex((f) => f.homeId === myClubId || f.awayId === myClubId);
  let meuJogo = null;
  if (mineIdx >= 0 && myClubId !== null) {
    const sim = sims[mineIdx], v = sim.teamView(myClubId)!, f = fixtures[mineIdx];
    meuJogo = {
      indice: mineIdx, relogio: sim.clock(), fim: sim.finished, intervalo: sim.isHalftime,
      mandante: clubRef(room, f.homeId), visitante: clubRef(room, f.awayId), gm: sim.score.home, gv: sim.score.away,
      mentalidade: v.mentality, auxiliar: v.autoSubs, substituicoes: v.subsUsed, maxSubstituicoes: v.maxSubs, capitao: v.captainId,
      emCampo: v.onPitch.map((x) => {
        const p = byId.get(x.id)!;
        return { id: x.id, nome: x.name, funcao: x.role, pos: x.position, cond: x.fitness, amarelos: x.yellow, gols: x.goals,
          ovr: overall(p), naFuncao: Math.round(roleRating(p, x.role) * positionFactor(p.position, x.role)) };
      }),
      banco: v.bench.map((x) => { const p = byId.get(x.id)!; return { id: x.id, nome: x.name, pos: x.position, cond: x.fitness, ovr: overall(p), attrs: p.attrs }; }),
      sairam: v.out.map((x) => ({ id: x.id, nome: x.name, motivo: x.reason })),
    };
  }
  return {
    aoVivo: true, rodada: room.live.round, temporada: room.season, agora: Date.now(),
    inicio: room.live.startedAt, msPorMinuto: room.live.msPerTick, minutosJogados: t,
    jogos: fixtures.map((f, i) => ({
      divisao: f.tier, divisaoNome: tierName(room, f.tier), mandante: clubRef(room, f.homeId), visitante: clubRef(room, f.awayId),
      gm: sims[i].score.home, gv: sims[i].score.away, relogio: sims[i].clock(), fim: sims[i].finished, meu: i === mineIdx,
    })),
    meuJogo,
  };
}

function calendarView(room: Room, clubId: number) {
  const played = new Map(room.results.filter((r) => r.homeId === clubId || r.awayId === clubId).map((r) => [r.round, r]));
  return {
    temporada: room.season, rodadaAtual: room.round, aoVivo: room.live?.round ?? null,
    jogos: room.world.fixtures.filter((f) => f.homeId === clubId || f.awayId === clubId).sort((a, b) => a.round - b.round).map((f) => {
      const r = played.get(f.round);
      const casa = f.homeId === clubId;
      const adv = casa ? f.awayId : f.homeId;
      const gp = r ? (casa ? r.hg : r.ag) : null, gc = r ? (casa ? r.ag : r.hg) : null;
      const ac = clubById(room, adv);
      return {
        rodada: f.round, casa, adversario: { ...clubRef(room, adv), forca: avgTop11(room, adv) },
        classico: ac.rivalId === clubId || clubById(room, clubId).rivalId === adv,
        gp, gc, resultado: r ? (gp! > gc! ? 'V' : gp === gc ? 'E' : 'D') : null,
      };
    }),
  };
}

/** Artilheiros e seleção do campeonato (média das notas) de uma divisão. */
function highlightsView(room: Room, tier: number) {
  const clubs = new Map(room.world.clubs.filter((c) => c.tier === tier).map((c) => [c.id, c]));
  const rows = room.world.players
    .filter((p) => p.clubId !== null && clubs.has(p.clubId) && room.status[p.id]?.apps)
    .map((p) => ({ p, s: room.status[p.id], c: clubs.get(p.clubId!)! }));
  const avg = (x: (typeof rows)[number]) => x.s.ratingSum / x.s.apps;
  const row = (x: (typeof rows)[number]) => ({
    id: x.p.id, nome: x.p.name, pos: x.p.position, clube: { id: x.c.id, nome: x.c.name, sigla: x.c.shortName },
    gols: x.s.goals, jogos: x.s.apps, nota: Math.round(avg(x) * 10) / 10,
  });
  const minJogos = Math.max(1, Math.ceil(room.round * 0.4));
  const used = new Set<number>();
  const selecao = FORMATIONS['4-3-3'].map((role) => {
    const best = rows.filter((x) => x.p.position === role && x.s.apps >= minJogos && !used.has(x.p.id)).sort((a, b) => avg(b) - avg(a))[0];
    if (best) used.add(best.p.id);
    return { funcao: role, jogador: best ? row(best) : null };
  });
  return {
    divisao: tier, nome: tierName(room, tier), rodada: room.round, minJogos,
    artilheiros: rows.filter((x) => x.s.goals > 0).sort((a, b) => b.s.goals - a.s.goals || a.s.apps - b.s.apps).slice(0, 15).map(row),
    selecao: { formacao: '4-3-3', jogadores: selecao },
  };
}

// ============================================================== rotas
type Handler = (req: IncomingMessage, res: ServerResponse, params: string[]) => Promise<void>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, pattern: string, h: Handler) =>
  routes.push([method, new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$'), h]);

const USERNAME = /^[A-Za-z0-9_.-]{3,20}$/;

route('POST', '/api/cadastro', async (req, res) => {
  const { usuario, senha } = await readBody(req);
  if (typeof usuario !== 'string' || !USERNAME.test(usuario)) throw new HttpError(400, 'Usuário: 3 a 20 letras, números, ponto, hífen ou _.');
  if (typeof senha !== 'string' || senha.length < 4) throw new HttpError(400, 'A senha precisa de pelo menos 4 caracteres.');
  if (findUser(usuario)) throw new HttpError(409, 'Esse nome de usuário já existe.');
  const u = createUser(usuario, senha);
  send(res, 200, { usuario: u.username }, { 'Set-Cookie': sessionCookie(createSession(u.id), 30 * 86400) });
});

route('POST', '/api/login', async (req, res) => {
  const { usuario, senha } = await readBody(req);
  const u = typeof usuario === 'string' ? findUser(usuario) : undefined;
  if (!u || typeof senha !== 'string' || !checkPassword(senha, u.salt, u.hash)) throw new HttpError(401, 'Usuário ou senha incorretos.');
  send(res, 200, { usuario: u.username }, { 'Set-Cookie': sessionCookie(createSession(u.id), 30 * 86400) });
});

route('POST', '/api/sair', async (req, res) => {
  deleteSession(cookie(req, 'sessao'));
  send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
});

route('GET', '/api/eu', async (req, res) => {
  const u = requireUser(req);
  send(res, 200, { usuario: u.username });
});

route('GET', '/api/salas', async (req, res) => {
  const u = requireUser(req);
  const mine = allRooms().filter((r) => r.members.some((m) => m.userId === u.id))
    .sort((a, b) => (b.lastRunAt ?? b.createdAt) - (a.lastRunAt ?? a.createdAt));
  send(res, 200, mine.map((r) => roomListItem(r, u.id)));
});

route('POST', '/api/salas', async (req, res) => {
  const u = requireUser(req);
  const { settings, senha } = await readBody(req);
  if (!settings || typeof settings !== 'object') throw new HttpError(400, 'Configuração da sala ausente.');
  let pw: string | null = null;
  if ((settings as RoomSettings).isPrivate && typeof senha === 'string' && senha.length) {
    const h = hashPassword(senha); pw = `${h.salt}:${h.hash}`;
  }
  let room: Room;
  try {
    room = createRoom({
      id: newId(), ownerId: u.id, ownerName: u.username, settings: settings as RoomSettings,
      passwordHash: pw, usedCodes: new Set(allRooms().map((r) => r.code)),
    });
  } catch (e) {
    if (e instanceof GameError) throw e;
    throw new HttpError(400, 'Configuração da sala inválida.');
  }
  saveRoom(room);
  send(res, 200, { id: room.id, codigo: room.code });
});

route('POST', '/api/salas/entrar', async (req, res) => {
  const u = requireUser(req);
  const { codigo, senha } = await readBody(req);
  const room = typeof codigo === 'string' ? roomByCode(codigo.trim()) : undefined;
  if (!room) throw new HttpError(404, 'Nenhuma sala com esse código.');
  if (!room.members.some((m) => m.userId === u.id) && room.passwordHash) {
    const [salt, hash] = room.passwordHash.split(':');
    if (typeof senha !== 'string' || !checkPassword(senha, salt, hash)) throw new HttpError(403, 'Senha da sala incorreta.');
  }
  joinRoom(room, u.id, u.username);
  saveRoom(room);
  send(res, 200, { id: room.id });
});

route('GET', '/api/salas/:id', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  requireMember(room, u);
  if (tick(room!)) saveRoom(room!);
  send(res, 200, stateView(room!, u));
});

route('GET', '/api/salas/:id/clubes-livres', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id); requireMember(room, u);
  send(res, 200, {
    regra: room!.settings.structure.humanStart,
    clubes: freeClubs(room!).map((c) => ({
      ...clubRef(room!, c.id), divisao: c.tier, divisaoNome: tierName(room!, c.tier),
      cidade: room!.world.cities.find((x) => x.id === c.cityId)?.name, uf: room!.world.cities.find((x) => x.id === c.cityId)?.state,
      reputacao: c.reputation, torcida: c.fanBase, caixa: c.balance, forca: avgTop11(room!, c.id), estadio: c.stadiumName,
    })).sort((a, b) => a.divisao - b.divisao || b.forca - a.forca),
  });
});

route('POST', '/api/salas/:id/clube', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id); requireMember(room, u);
  const { clubeId } = await readBody(req);
  pickClub(room!, u.id, typeof clubeId === 'number' ? clubeId : null);
  saveRoom(room!);
  send(res, 200, stateView(room!, u));
});

route('GET', '/api/salas/:id/elenco', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  send(res, 200, squadView(room!, clubId));
});

route('PUT', '/api/salas/:id/escalacao', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { formacao, titulares, reservas, mentalidade, capitao } = await readBody(req);
  setTactics(room!, clubId, { formation: formacao, lineup: titulares, bench: reservas, mentality: mentalidade, captainId: capitao ?? undefined });
  saveRoom(room!);
  send(res, 200, squadView(room!, clubId));
});

route('POST', '/api/salas/:id/escalacao/auto', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { formacao, mentalidade } = await readBody(req);
  const t = autoTactics(room!, clubId, FORMATIONS[formacao] ? formacao : '4-4-2', ([-2, -1, 0, 1, 2].includes(mentalidade) ? mentalidade : 0) as Mentality);
  setTactics(room!, clubId, t);
  saveRoom(room!);
  send(res, 200, squadView(room!, clubId));
});

route('POST', '/api/salas/:id/pronto', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id); requireMember(room, u);
  const { pronto } = await readBody(req);
  setReady(room!, u.id, pronto !== false);
  tick(room!);
  saveRoom(room!);
  send(res, 200, stateView(room!, u));
});

route('GET', '/api/salas/:id/rodada/:n', async (req, res, [id, n]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const m = requireMember(room, u);
  send(res, 200, roundView(room!, Number(n), m.clubId));
});

route('GET', '/api/salas/:id/tabela/:tier', async (req, res, [id, tier]) => {
  const u = requireUser(req);
  const room = roomById(id); requireMember(room, u);
  const t = Number(tier);
  if (!room!.world.divisions.some((d) => d.tier === t)) throw new HttpError(404, 'Divisão não encontrada.');
  const { promotion, relegation, divisions } = room!.settings.structure;
  send(res, 200, {
    divisao: t, nome: tierName(room!, t), sobem: t > 1 ? promotion : 0, descem: t < divisions ? relegation : 0,
    linhas: standings(room!, t),
  });
});

route('GET', '/api/salas/:id/ao-vivo', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const m = requireMember(room, u);
  if (tick(room!)) saveRoom(room!);
  send(res, 200, liveView(room!, m.clubId));
});

route('POST', '/api/salas/:id/ao-vivo/acao', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { tipo, sai, entra, valor, ligado } = await readBody(req);
  if (tipo === 'SUBSTITUICAO') liveAction(room!, clubId, { kind: 'SUB', outId: Number(sai), inId: Number(entra) });
  else if (tipo === 'MENTALIDADE') liveAction(room!, clubId, { kind: 'MENT', mentality: Number(valor) as Mentality });
  else if (tipo === 'AUXILIAR') liveAction(room!, clubId, { kind: 'AUTO', on: !!ligado });
  else throw new HttpError(400, 'Ação inválida.');
  saveRoom(room!);
  send(res, 200, liveView(room!, clubId));
});

route('GET', '/api/salas/:id/calendario', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  send(res, 200, calendarView(room!, requireClub(room!, u)));
});

route('GET', '/api/salas/:id/mensagens', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id); requireMember(room, u);
  const box = inboxOf(room!, u.id);
  send(res, 200, { naoLidas: box.filter((x) => !x.read).length, mensagens: box });
});

route('POST', '/api/salas/:id/mensagens/lidas', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id); requireMember(room, u);
  const { ids } = await readBody(req);
  markRead(room!, u.id, Array.isArray(ids) ? ids.map(Number) : 'all');
  saveRoom(room!);
  send(res, 200, { naoLidas: inboxOf(room!, u.id).filter((x) => !x.read).length });
});

route('POST', '/api/salas/:id/renovar', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { jogadorId } = await readBody(req);
  const n = openRenewal(room!, clubId, Number(jogadorId));
  saveRoom(room!);
  send(res, 200, negotiationView(room!, n));
});

route('GET', '/api/salas/:id/negociacoes/:neg', async (req, res, [id, neg]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const n = (room!.negotiations ?? []).find((x) => x.id === neg && x.clubId === clubId);
  if (!n) throw new HttpError(404, 'Negociação não encontrada.');
  send(res, 200, negotiationView(room!, n));
});

route('POST', '/api/salas/:id/negociacoes/:neg', async (req, res, [id, neg]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { acao, valor, temporadas } = await readBody(req);
  if (!['PROPOR', 'ACEITAR', 'ENCERRAR'].includes(acao)) throw new HttpError(400, 'Ação inválida.');
  // o valor chega em reais; internamente é centavos
  const n = negotiate(room!, clubId, neg, acao, acao === 'PROPOR' ? { amount: Math.round(Number(valor) * 100), seasons: Number(temporadas) } : undefined);
  saveRoom(room!);
  send(res, 200, negotiationView(room!, n));
});

route('GET', '/api/salas/:id/patrocinios', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  send(res, 200, sponsorshipView(room!, requireClub(room!, u)));
});

route('POST', '/api/salas/:id/patrocinios/:slot/romper', async (req, res, [id, slot]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const multa = breakSponsorship(room!, clubId, slot as SponsorSlot);
  saveRoom(room!);
  send(res, 200, { multa, patrocinios: sponsorshipView(room!, clubId) });
});

route('GET', '/api/salas/:id/destaques/:tier', async (req, res, [id, tier]) => {
  const u = requireUser(req);
  const room = roomById(id); requireMember(room, u);
  send(res, 200, highlightsView(room!, Number(tier)));
});

route('GET', '/api/salas/:id/mercado', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const q = new URL(req.url ?? '', 'http://x').searchParams;
  const num = (k: string) => (q.get(k) ? Number(q.get(k)) : undefined);
  const f: SearchFilters = {
    nome: q.get('nome') ?? undefined, pos: q.get('pos') ?? undefined, idadeMin: num('idadeMin'), idadeMax: num('idadeMax'),
    forcaMin: num('forcaMin'), valorMax: num('valorMax') !== undefined ? num('valorMax')! * 100 : undefined,
    carac: q.get('carac') ?? undefined, divisao: q.get('divisao') ?? undefined,
    aVenda: q.get('aVenda') === '1', livres: q.get('livres') === '1', ocultarMeu: q.get('ocultarMeu') !== '0',
  };
  send(res, 200, searchPlayers(room!, clubId, f));
});

route('GET', '/api/salas/:id/jogadores/:pid', async (req, res, [id, pid]) => {
  const u = requireUser(req);
  const room = roomById(id);
  send(res, 200, playerDetail(room!, requireClub(room!, u), Number(pid)));
});

route('POST', '/api/salas/:id/jogadores/:pid/interesse', async (req, res, [id, pid]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { valor } = await readBody(req);
  const r = startInterest(room!, clubId, Number(pid), valor ? Math.round(Number(valor) * 100) : undefined);
  saveRoom(room!);
  const n = r.negId ? room!.negotiations!.find((x) => x.id === r.negId)! : null;
  send(res, 200, { negociacao: n ? negotiationView(room!, n) : null, propostaEnviada: !!r.offerId });
});

route('POST', '/api/salas/:id/jogadores/:pid/venda', async (req, res, [id, pid]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { preco } = await readBody(req);
  const l = setForSale(room!, clubId, Number(pid), preco === null || preco === undefined ? null : Math.round(Number(preco) * 100));
  saveRoom(room!);
  send(res, 200, { aVenda: l?.price ?? null });
});

route('POST', '/api/salas/:id/ofertas/:of', async (req, res, [id, of]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { aceitar } = await readBody(req);
  answerHumanOffer(room!, clubId, of, !!aceitar);
  saveRoom(room!);
  send(res, 200, { ok: true });
});

route('GET', '/api/salas/:id/financas', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  send(res, 200, financeView(room!, requireClub(room!, u)));
});

route('POST', '/api/salas/:id/campanhas', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  const { tipo, ativa } = await readBody(req);
  if (!(tipo in CAMPAIGNS)) throw new HttpError(400, 'Campanha inválida.');
  if (ativa) startCampaign(room!, clubId, tipo); else stopCampaign(room!, clubId, tipo);
  saveRoom(room!);
  send(res, 200, financeView(room!, clubId));
});

// ======================================================= estádio e base
const pricesFromBody = (b: Record<string, unknown>) => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries((b.precos ?? {}) as Record<string, unknown>)) out[k] = Math.round(Number(v) * 100);
  return out;
};
route('GET', '/api/salas/:id/estadio', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  send(res, 200, stadiumView(room!, requireClub(room!, u)));
});
route('POST', '/api/salas/:id/estadio/precos', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  setTicketPrices(room!, clubId, pricesFromBody(await readBody(req)));
  saveRoom(room!);
  send(res, 200, stadiumView(room!, clubId));
});
route('POST', '/api/salas/:id/estadio/simular', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  send(res, 200, gatePreview(room!, requireClub(room!, u), pricesFromBody(await readBody(req))));
});
route('POST', '/api/salas/:id/obras', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  startProject(room!, clubId, await readBody(req));
  saveRoom(room!);
  send(res, 200, stadiumView(room!, clubId));
});
route('POST', '/api/salas/:id/obras/:ob/cancelar', async (req, res, [id, ob]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  cancelProject(room!, clubId, ob);
  saveRoom(room!);
  send(res, 200, stadiumView(room!, clubId));
});
route('GET', '/api/salas/:id/base', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  send(res, 200, youthView(room!, requireClub(room!, u)));
});
route('POST', '/api/salas/:id/base/peneira', async (req, res, [id]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  extraIntake(room!, clubId);
  saveRoom(room!);
  send(res, 200, youthView(room!, clubId));
});
route('POST', '/api/salas/:id/base/:pid/:acao', async (req, res, [id, pid, acao]) => {
  const u = requireUser(req);
  const room = roomById(id);
  const clubId = requireClub(room!, u);
  if (room!.live) throw new HttpError(400, 'Espere a rodada terminar.');
  if (acao === 'promover') promoteYouth(room!, clubId, Number(pid));
  else if (acao === 'dispensar') releaseYouth(room!, clubId, Number(pid));
  else throw new HttpError(404, 'Ação inválida.');
  saveRoom(room!);
  send(res, 200, youthView(room!, clubId));
});

// ======================================================= arquivos web
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
async function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
  if (path === '/') path = '/index.html';
  const file = normalize(join(WEB_DIR, decodeURIComponent(path)));
  if (!file.startsWith(WEB_DIR)) { res.writeHead(403).end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Página não encontrada.');
  }
}

// ============================================================ servidor
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const [method, re, h] of routes) {
        const m = re.exec(url.pathname);
        if (m && method === req.method) { await h(req, res, m.slice(1)); return; }
      }
      throw new HttpError(404, 'Rota não encontrada.');
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Método não permitido.');
    await serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e instanceof HttpError) send(res, e.status, { erro: e.message });
    else if (e instanceof GameError || e instanceof OfficeError) send(res, 400, { erro: e.message });
    else { console.error(e); send(res, 500, { erro: 'Erro interno no servidor.' }); }
  }
});

// Salas salvas por versões antigas podem ter números quebrados (ex.: humor 70,39...)
for (const room of allRooms()) { normalizeRoom(room); saveRoom(room); }

// Roda rodadas pendentes (tempo limite estourado, ou todos prontos esperando a espera mínima)
setInterval(() => {
  for (const room of allRooms()) {
    try { if (tick(room)) saveRoom(room); } catch (e) { console.error('Erro ao rodar a sala', room.id, e); }
  }
}, 2000);

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Manager rodando em ${url}`);
  console.log(`  Dados salvos em ${dataDir}`);
  console.log('  Para parar: Ctrl+C\n');
  if (process.argv.includes('--abrir')) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open ${url}` : `xdg-open ${url}`;
    exec(cmd, () => {});
  }
});
