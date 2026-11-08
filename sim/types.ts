// Tipos compartilhados pelo simulador. Espelham as tabelas do schema.sql,
// mas só com os campos que a simulação precisa.

export type Position = 'GOL' | 'ZAG' | 'LAT' | 'VOL' | 'MEI' | 'ATA';

export type Attribute =
  | 'pace' | 'stamina' | 'strength' | 'passing' | 'dribbling'
  | 'finishing' | 'defending' | 'heading' | 'goalkeeping' | 'vision';

export const ATTRIBUTES: Attribute[] = [
  'pace', 'stamina', 'strength', 'passing', 'dribbling',
  'finishing', 'defending', 'heading', 'goalkeeping', 'vision',
];

export interface Player {
  id: number;
  name: string;
  age: number;
  position: Position;   // posição natural
  attrs: Record<Attribute, number>; // 1..100
  potential: number;    // 1..100
  form: number;         // 0..100
  fitness: number;      // 0..100
  morale: number;       // 0..100
  popularity: number;   // 0..100
}

export interface LineupSlot {
  player: Player;
  role: Position;       // onde está jogando (pode ser fora de posição)
}

export interface Staff {
  coachTactics: number;      // técnico: tática 1..100
  coachMotivation: number;   // técnico: motivação 1..100
  fitnessCoach: number;      // preparador físico 1..100 (0 = não tem)
  goalkeeperCoach: number;   // treinador de goleiros 1..100
  doctor: number;            // médico 1..100 (reduz tempo de lesão)
  physio: number;            // fisioterapeuta 1..100 (reduz chance de lesão)
  youthCoach: number;        // treinador da base 1..100
}

export interface TeamSetup {
  clubId: number;
  name: string;
  lineup: LineupSlot[];      // 11 titulares
  bench: Player[];           // até 7 reservas
  mentality: -2 | -1 | 0 | 1 | 2;
  staff: Staff;
  fanMood: number;           // 0..100
  isAI?: boolean;            // clube sem dono humano (recebe o modificador de dificuldade)
  autoSubs?: boolean;        // auxiliar faz trocas por cansaço (padrão: sim)
  captainId?: number;        // capitão escolhido (se não vier, o maior líder entre os titulares)
}

export type EventType =
  | 'GOL' | 'CHANCE' | 'DEFESA' | 'AMARELO' | 'VERMELHO'
  | 'LESAO' | 'SUBSTITUICAO' | 'INTERVALO' | 'FIM';

export interface MatchEvent {
  minute: number;
  type: EventType;
  clubId?: number;
  playerId?: number;
  text: string;
}

export interface PlayerMatchState {
  playerId: number;
  clubId: number;
  minutesPlayed: number;
  fitnessAfter: number;
  goals: number;
  yellow: number;
  red: boolean;
  injuryRounds: number;      // 0 = não se machucou
  rating: number;            // nota 3.0..10.0
}

export interface MatchResult {
  homeGoals: number;
  awayGoals: number;
  events: MatchEvent[];
  players: PlayerMatchState[];
  stats: {
    possessionHome: number;  // %
    shotsHome: number;
    shotsAway: number;
  };
}
