// Comportamento da torcida conforme o humor (0 a 100).
//
// Humor baixo: vaias em casa (o time rende menos), agressões a jogadores e invasões ao CT.
//   Quanto menor o humor, maior a chance. Derrota na rodada aumenta o risco.
// Humor alto: apoio (treino aberto, recepção depois de vitória fora) e mosaicos nos jogos
//   em casa, que empurram o time (+3% de força) e ficam guardados com a imagem.
//
// Os mosaicos e as vaias de cada rodada são decididos antes dos jogos e guardados em
// room.crowdRound, para que a rodada ao vivo, se for reconstruída, dê o mesmo resultado.
// Agressões e invasões só acontecem com clubes de técnicos humanos.

import { Rng } from '../sim/rng.ts';
import { overall } from '../sim/strength.ts';
import type { GenClub, GenFixture } from '../sim/worldgen.ts';
import type { Room } from './engine.ts';
import { brl, sendToClub } from './office.ts';

export type MosaicPattern = 'SIGLA' | 'ESCUDO' | 'LISTRAS' | 'ESTRELA' | 'DIAGONAL';
export interface MosaicDesign { pattern: MosaicPattern; hue: number; hue2: number; text: string; seed: number }
export type CrowdKind = 'MOSAICO' | 'APOIO' | 'VAIA' | 'AGRESSAO' | 'INVASAO' | 'MOSAICO_RIVAL';
export interface CrowdEvent {
  season: number; round: number; kind: CrowdKind; title: string; text: string;
  mosaic?: MosaicDesign; opponent?: string;
}
/** O que a torcida faz em cada jogo da rodada (decidido antes da bola rolar). */
export interface CrowdRound { season: number; round: number; mosaics: Record<number, MosaicDesign>; boos: number[] }

export const MOSAIC_BOOST = 0.03;      // +3% de força para o mandante com mosaico
export const BOO_PENALTY = -0.03;      // -3% para o mandante vaiado (humor abaixo de 25)

export const MOOD_BANDS = [
  { min: 80, name: 'Apaixonada', tone: 'good', text: 'Mosaicos frequentes nos jogos em casa, treinos abertos lotados e o maior empurrão do mando de campo.' },
  { min: 65, name: 'Animada', tone: 'good', text: 'Apoia o time, às vezes faz mosaico e aparece no treino.' },
  { min: 45, name: 'Tranquila', tone: '', text: 'Acompanha o time sem cobrar demais.' },
  { min: 30, name: 'Insatisfeita', tone: 'warn', text: 'Cobra nas redes e no estádio. Abaixo de 30, começam os riscos de agressão a jogadores.' },
  { min: 15, name: 'Hostil', tone: 'bad', text: 'Vaia o time em casa (−3% de força). Risco de agressão a jogadores e de invasão ao CT.' },
  { min: 0, name: 'Revoltada', tone: 'bad', text: 'Vaias, agressões e invasões ao CT ficam bem prováveis. Vitórias e ações de marketing ajudam a acalmar.' },
] as const;
export const bandOf = (mood: number) => MOOD_BANDS.find((b) => mood >= b.min)!;

/** Chances por rodada (0..1), exibidas no painel e usadas no sorteio. */
export function crowdOdds(mood: number, derby = false) {
  return {
    mosaico: Math.min(0.85, (mood >= 80 ? 0.4 + (mood - 80) * 0.015 : mood >= 65 ? 0.08 + (mood - 65) * 0.012 : 0) + (derby && mood >= 65 ? 0.25 : 0)),
    apoio: mood >= 70 ? 0.15 + (mood - 70) * 0.01 : 0,
    agressao: mood < 30 ? 0.04 + ((30 - mood) / 30) * 0.22 : 0,
    invasao: mood < 20 ? 0.03 + ((20 - mood) / 20) * 0.17 : 0,
    vaia: mood < 25,
  };
}

// ================================================================ util
const clubOf = (room: Room, id: number) => room.world.clubs.find((c) => c.id === id)!;
const humans = (room: Room) => new Set(room.members.filter((m) => m.clubId !== null).map((m) => m.clubId!));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isDerby = (a: GenClub, b: GenClub) => a.rivalId === b.id || b.rivalId === a.id;

function log(room: Room, clubId: number, e: Omit<CrowdEvent, 'season' | 'round'>) {
  room.crowdLog ??= {};
  const list = (room.crowdLog[clubId] ??= []);
  list.unshift({ season: room.season, round: room.round, ...e });
  if (list.length > 30) list.length = 30;
}

const PHRASES = ['RAÇA', 'GARRA', 'AVANTE', 'FÉ', 'VAMOS', 'JUNTOS'];
function designFor(club: GenClub, rng: Rng): MosaicDesign {
  const patterns: MosaicPattern[] = ['SIGLA', 'ESCUDO', 'LISTRAS', 'ESTRELA', 'DIAGONAL'];
  const hue = (club.id * 137) % 360;   // mesma cor do escudo do clube
  return {
    pattern: patterns[rng.int(0, patterns.length - 1)], hue, hue2: (hue + 40) % 360,
    text: rng.next() < 0.6 ? club.shortName.toUpperCase() : PHRASES[rng.int(0, PHRASES.length - 1)],
    seed: rng.int(1, 1_000_000),
  };
}

// ======================================================= antes dos jogos
/** Decide mosaicos e vaias da rodada (uma vez; chamadas repetidas devolvem o mesmo). */
export function crowdForRound(room: Room, round: number, fixtures: GenFixture[]): CrowdRound {
  const cur = room.crowdRound;
  if (cur && cur.season === room.season && cur.round === round) return cur;
  const rng = new Rng((room.world.seed * 31 + room.season * 7919 + round * 104729) % 2_147_483_647);
  const out: CrowdRound = { season: room.season, round, mosaics: {}, boos: [] };
  for (const f of fixtures) {
    const home = clubOf(room, f.homeId), away = clubOf(room, f.awayId);
    const odds = crowdOdds(home.fanMood, isDerby(home, away));
    if (odds.vaia) out.boos.push(home.id);
    else if (rng.next() < odds.mosaico) out.mosaics[home.id] = designFor(home, rng);
  }
  room.crowdRound = out;
  return out;
}

/** Ajuste de força do mandante pela torcida (mosaico ou vaia). */
export function crowdBoost(cr: CrowdRound, clubId: number) {
  return cr.mosaics[clubId] ? MOSAIC_BOOST : cr.boos.includes(clubId) ? BOO_PENALTY : 0;
}

// ======================================================= depois dos jogos
export function crowdAfterRound(room: Room, round: number) {
  const H = humans(room);
  const cr = room.crowdRound?.season === room.season && room.crowdRound.round === round ? room.crowdRound : null;
  const rng = new Rng(Math.floor(Math.random() * 2_000_000_000));
  const results = room.results.filter((r) => r.round === round);

  for (const clubId of H) {
    const club = clubOf(room, clubId);
    const r = results.find((x) => x.homeId === clubId || x.awayId === clubId);
    const home = r?.homeId === clubId;
    const opp = r ? clubOf(room, home ? r.awayId : r.homeId) : null;
    const gf = r ? (home ? r.hg : r.ag) : 0, ga = r ? (home ? r.ag : r.hg) : 0;
    const lost = !!r && gf < ga, won = !!r && gf > ga;
    const squad = room.world.players.filter((p) => p.clubId === clubId && !p.isYouth);
    const mood = club.fanMood;

    // ---------------------------------------------------- mosaicos e vaias do jogo
    if (r && cr) {
      const mine = cr.mosaics[clubId];
      if (home && mine) {
        log(room, clubId, { kind: 'MOSAICO', title: `Mosaico contra o ${opp!.name}`, opponent: opp!.name, mosaic: mine,
          text: `A torcida cobriu as arquibancadas com um mosaico "${mine.text}" antes do jogo (${gf} × ${ga}). O time entrou empurrado (+${MOSAIC_BOOST * 100}% de força).` });
        sendToClub(room, clubId, { type: 'TORCIDA', title: `Mosaico da torcida contra o ${opp!.name}`, mosaic: mine,
          body: `Antes da bola rolar, a torcida montou um mosaico "${mine.text}" no ${club.stadiumName}. O time jogou com +${MOSAIC_BOOST * 100}% de força. Placar: ${gf} × ${ga}.` });
        for (const p of squad) p.morale = clamp(p.morale + 3, 0, 100);
      }
      const theirs = !home && opp ? cr.mosaics[opp.id] : undefined;
      if (theirs) {
        log(room, clubId, { kind: 'MOSAICO_RIVAL', title: `Mosaico do ${opp!.name}`, opponent: opp!.name, mosaic: theirs,
          text: `A torcida do ${opp!.name} fez mosaico e empurrou o time da casa (${gf} × ${ga} para você).` });
      }
      if (home && cr.boos.includes(clubId)) {
        log(room, clubId, { kind: 'VAIA', title: `Vaias contra o ${opp!.name}`, opponent: opp!.name,
          text: `${won ? `O time entrou sob vaias, mas a vitória por ${gf} × ${ga} calou parte da arquibancada.` : `O time foi vaiado do aquecimento ao apito final (${gf} × ${ga}).`} Jogar em casa virou peso: −${-BOO_PENALTY * 100}% de força.` });
        for (const p of squad) p.morale = clamp(p.morale - 2, 0, 100);
      }
    }

    const odds = crowdOdds(mood);
    const riskMul = lost ? 1.5 : won ? 0.5 : 1;

    // ---------------------------------------------------- agressão a jogador
    if (squad.length && rng.next() < odds.agressao * riskMul) {
      // alvo: quem foi mal na rodada ou ganha muito
      const rating = new Map((room.results.find((x) => x === r)?.ratings ?? []).filter((x) => x.clubId === clubId).map((x) => [x.playerId, x.rating]));
      const weight = (p: typeof squad[number]) => (rating.has(p.id) ? Math.max(0.5, 8 - rating.get(p.id)!) * 2 : 1) * (1 + p.weeklySalary / 5_000_000);
      const total = squad.reduce((s, p) => s + weight(p), 0);
      let x = rng.next() * total, k = 0;
      while (k < squad.length - 1 && (x -= weight(squad[k])) > 0) k++;
      const p = squad[k];
      const st = (room.status[p.id] ??= { injured: 0, suspended: 0, yellows: 0, goals: 0, apps: 0, ratingSum: 0 });
      const hurt = room.settings.rules.injuries && rng.next() < 0.55 ? rng.int(1, 3) : 0;
      if (hurt) st.injured = Math.max(st.injured, hurt);
      p.morale = clamp(p.morale - 20, 0, 100);
      p.form = clamp(p.form - 8, 0, 100);
      for (const q of squad) if (q !== p) q.morale = clamp(q.morale - 4, 0, 100);
      club.reputation = clamp(club.reputation - 1, 1, 100);
      const where = ['na saída do estádio', 'na porta do CT', 'num restaurante', 'no estacionamento do clube'][rng.int(0, 3)];
      const text = `${p.name} (${p.position}, geral ${overall(p)}) foi cercado e agredido por torcedores ${where}.${hurt ? ` Está fora por ${hurt} rodada${hurt > 1 ? 's' : ''}.` : ' Não se machucou, mas ficou abalado.'} O elenco inteiro sentiu (moral em queda) e a reputação do clube caiu.`;
      log(room, clubId, { kind: 'AGRESSAO', title: `${p.name} agredido por torcedores`, text });
      sendToClub(room, clubId, { type: 'TORCIDA', playerId: p.id, title: `${p.name} agredido por torcedores`, body: `${text} Humor da torcida: ${mood}.` });
    }

    // ---------------------------------------------------- invasão ao CT
    if (rng.next() < odds.invasao * riskMul) {
      const ex = room.clubExtra?.[clubId];
      const dmg = rng.int(10, 20);
      if (ex) ex.condition.CT = clamp(ex.condition.CT - dmg, 20, 100);
      const cost = club.facilities.CT * 150_000 * 100;
      club.balance -= cost;
      const cs = room.clubs[clubId];
      cs.expense['Danos e segurança'] = (cs.expense['Danos e segurança'] ?? 0) + cost;
      cs.lastRound.expense['Danos e segurança'] = (cs.lastRound.expense['Danos e segurança'] ?? 0) + cost;
      for (const q of squad) { q.morale = clamp(q.morale - 8, 0, 100); q.fitness = clamp(q.fitness - 8, 0, 100); }
      const text = `Torcedores invadiram o centro de treinamento, cobraram os jogadores e depredaram as instalações. Conservação do CT caiu ${dmg} pontos, o conserto e a segurança custaram ${brl(cost)} e o treino da semana foi suspenso (moral e condição física em queda).`;
      log(room, clubId, { kind: 'INVASAO', title: 'Invasão ao CT', text });
      sendToClub(room, clubId, { type: 'TORCIDA', title: 'Torcida invade o CT', body: `${text} Humor da torcida: ${mood}.` });
      room.news.unshift({ at: Date.now(), text: `Torcedores do ${club.name} invadem o CT.` }); room.news.length = Math.min(room.news.length, 40);
    }

    // ---------------------------------------------------- apoio
    if (rng.next() < odds.apoio * (won ? 1.4 : 1)) {
      const away = r && !home && won;
      for (const q of squad) { q.morale = clamp(q.morale + 6, 0, 100); q.form = clamp(q.form + 3, 0, 100); }
      const text = away
        ? `Centenas de torcedores receberam o elenco no aeroporto depois da vitória sobre o ${opp!.name}. Moral e forma do elenco em alta.`
        : `O treino aberto lotou: a torcida cantou o tempo todo e pediu autógrafos. Moral e forma do elenco em alta.`;
      log(room, clubId, { kind: 'APOIO', title: away ? 'Festa no aeroporto' : 'Treino aberto lotado', text });
      sendToClub(room, clubId, { type: 'TORCIDA', title: away ? 'Festa da torcida no aeroporto' : 'Treino aberto lotado', body: text });
    }
  }
}

// ================================================================ views
export function crowdView(room: Room, clubId: number) {
  const club = clubOf(room, clubId);
  const band = bandOf(club.fanMood);
  const next = room.world.fixtures.find((f) => f.round === room.round + 1 && (f.homeId === clubId || f.awayId === clubId));
  const derby = next ? isDerby(clubOf(room, next.homeId), clubOf(room, next.awayId)) : false;
  const odds = crowdOdds(club.fanMood, derby);
  const events = (room.crowdLog?.[clubId] ?? []).slice(0, 8);
  const lastMosaic = (room.crowdLog?.[clubId] ?? []).find((e) => e.kind === 'MOSAICO');
  return {
    humor: club.fanMood, faixa: band.name, tom: band.tone, descricao: band.text,
    proximoEmCasa: !!next && next.homeId === clubId, classico: derby,
    chances: { mosaico: Math.round(odds.mosaico * 100), apoio: Math.round(odds.apoio * 100), agressao: Math.round(odds.agressao * 100), invasao: Math.round(odds.invasao * 100), vaia: odds.vaia },
    eventos: events.map((e) => ({ temporada: e.season, rodada: e.round, tipo: e.kind, titulo: e.title, texto: e.text, mosaico: e.mosaic ?? null })),
    ultimoMosaico: lastMosaic ? { temporada: lastMosaic.season, rodada: lastMosaic.round, adversario: lastMosaic.opponent, mosaico: lastMosaic.mosaic } : null,
  };
}
