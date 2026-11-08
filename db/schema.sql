-- =====================================================================
--  Football Manager Multiplayer — Schema PostgreSQL
--  Convenções:
--    * Dinheiro sempre em CENTAVOS (BIGINT) para evitar erro de arredondamento.
--    * Atributos de jogador e níveis de staff de 1 a 100.
--    * Tudo pertence a um "world" (servidor/mundo), para rodar várias ligas
--      independentes no mesmo banco.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------
CREATE TYPE position_t      AS ENUM ('GOL','ZAG','LAT','VOL','MEI','ATA');
CREATE TYPE foot_t          AS ENUM ('D','E','AMBOS');
CREATE TYPE staff_role_t    AS ENUM ('TECNICO','AUXILIAR','PREP_FISICO','TREINADOR_GOLEIROS',
                                     'MEDICO','FISIOTERAPEUTA','OLHEIRO','TREINADOR_BASE');
CREATE TYPE contract_status AS ENUM ('ATIVO','ENCERRADO','RESCINDIDO');
CREATE TYPE facility_t      AS ENUM ('ESTADIO','CT','BASE','DEPTO_MEDICO');
CREATE TYPE project_status  AS ENUM ('EM_ANDAMENTO','CONCLUIDO','CANCELADO');
CREATE TYPE offer_status    AS ENUM ('PENDENTE','ACEITA','RECUSADA','CANCELADA','EXPIRADA');
CREATE TYPE match_status    AS ENUM ('AGENDADA','EM_SIMULACAO','FINALIZADA');
CREATE TYPE event_t         AS ENUM ('GOL','CHANCE','DEFESA','AMARELO','VERMELHO','LESAO','SUBSTITUICAO','INTERVALO','FIM');
CREATE TYPE ledger_t        AS ENUM ('BILHETERIA','PATROCINIO','TV','PREMIACAO','VENDA_JOGADOR','COMPRA_JOGADOR',
                                     'SALARIO_JOGADOR','SALARIO_STAFF','MULTA_RESCISAO','OBRA','MANUTENCAO',
                                     'MARKETING','SOCIO_TORCEDOR','MERCHANDISING','OUTRO');
CREATE TYPE training_focus  AS ENUM ('FISICO','TECNICO','TATICO','FINALIZACAO','DEFESA','GOLEIRO','RECUPERACAO');
CREATE TYPE sector_t        AS ENUM ('GERAL','ARQUIBANCADA','CADEIRA','CAMAROTE');
CREATE TYPE room_status     AS ENUM ('LOBBY','EM_ANDAMENTO','PAUSADA','ENCERRADA');
CREATE TYPE campaign_kind   AS ENUM ('REDES_SOCIAIS','TV_RADIO','ESCOLAS','EXCURSAO','PROJETO_SOCIAL','INGRESSO_SOLIDARIO');

-- ---------------------------------------------------------------------
-- USUÁRIOS E MUNDOS
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Um "mundo" é uma SALA multiplayer com seu próprio calendário e regras.
CREATE TABLE worlds (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  owner_user_id   UUID REFERENCES users(id),          -- quem criou a sala (pode editar regras)
  status          room_status NOT NULL DEFAULT 'LOBBY',
  join_code       TEXT UNIQUE,                        -- código para convidar (ex.: 'K7Q2XM')
  password_hash   TEXT,                               -- sala privada
  -- Regras completas (RoomSettings em sim/settings.ts): estrutura, regras,
  -- ritmo (tempo de preparação), dificuldade e velocidade das partidas.
  settings        JSONB NOT NULL,
  -- regras novas de estrutura/dificuldade entram só na próxima temporada
  pending_settings JSONB,
  rng_seed        BIGINT NOT NULL DEFAULT (floor(random() * 2147483647))::BIGINT,
  current_season  INT  NOT NULL DEFAULT 1,
  current_round   INT  NOT NULL DEFAULT 0,
  last_round_at   TIMESTAMPTZ,
  -- A rodada roda quando todos os humanos ativos estão prontos ou quando o
  -- tempo limite estoura (decideRound em sim/settings.ts).
  -- prep_started_at = fim da exibição "ao vivo" da rodada anterior.
  prep_started_at TIMESTAMPTZ,
  -- prazo calculado (prep_started_at + tempo limite); NULL = sem limite.
  -- Indexado para o timer achar rápido as salas com prazo vencido.
  prep_deadline   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON worlds (status, prep_deadline);

-- "Estou pronto" de cada humano na rodada
CREATE TABLE round_ready (
  world_id  INT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  round     INT NOT NULL,
  user_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ready_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (world_id, round, user_id)
);

-- Humanos na sala: controla prazos perdidos e AFK
CREATE TABLE room_members (
  world_id        INT  NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  missed_in_a_row INT  NOT NULL DEFAULT 0,   -- prazos estourados seguidos
  is_afk          BOOLEAN NOT NULL DEFAULT false, -- sala não espera por ele até clicar "Pronto" de novo
  PRIMARY KEY (world_id, user_id)
);

-- Cidades: definem o tamanho do mercado de torcedores
CREATE TABLE cities (
  id          SERIAL PRIMARY KEY,
  world_id    INT  NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  state       VARCHAR(2) NOT NULL,
  population  INT  NOT NULL CHECK (population > 0),
  UNIQUE (world_id, name)
);

CREATE TABLE divisions (
  id         SERIAL PRIMARY KEY,
  world_id   INT  NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,            -- "Série A", "Série B"...
  tier       INT  NOT NULL,            -- 1 = elite
  promote_n  INT  NOT NULL DEFAULT 4,
  relegate_n INT  NOT NULL DEFAULT 4,
  UNIQUE (world_id, tier)
);

-- ---------------------------------------------------------------------
-- CLUBES
-- ---------------------------------------------------------------------
CREATE TABLE clubs (
  id            SERIAL PRIMARY KEY,
  world_id      INT  NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  division_id   INT  REFERENCES divisions(id),
  owner_user_id UUID REFERENCES users(id),     -- NULL = clube controlado pela IA
  name          TEXT NOT NULL,
  short_name    VARCHAR(4) NOT NULL,
  city_id       INT  REFERENCES cities(id),
  rival_club_id INT  REFERENCES clubs(id),     -- clássico: vale o dobro para a torcida
  stadium_name  TEXT,
  balance       BIGINT NOT NULL DEFAULT 0,     -- caixa em centavos
  reputation    INT  NOT NULL DEFAULT 50 CHECK (reputation BETWEEN 1 AND 100),
  -- torcida (o tamanho define o valor dos patrocínios — ver sim/fans.ts)
  fan_base      INT  NOT NULL DEFAULT 20000,   -- número de torcedores
  fan_mood      INT  NOT NULL DEFAULT 60 CHECK (fan_mood BETWEEN 0 AND 100),
  win_streak    INT  NOT NULL DEFAULT 0,
  -- sócio-torcedor
  members          INT    NOT NULL DEFAULT 0,
  membership_price BIGINT NOT NULL DEFAULT 0 CHECK (membership_price >= 0), -- centavos/mês; 0 = programa desligado
  -- tática padrão
  formation     TEXT NOT NULL DEFAULT '4-4-2',
  mentality     INT  NOT NULL DEFAULT 0 CHECK (mentality BETWEEN -2 AND 2), -- -2 retranca .. +2 ataque total
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (world_id, name),
  UNIQUE (world_id, short_name)
);
CREATE INDEX ON clubs (world_id, division_id);
-- um usuário controla no máximo 1 clube por mundo
CREATE UNIQUE INDEX clubs_one_per_user ON clubs (world_id, owner_user_id) WHERE owner_user_id IS NOT NULL;

-- Histórico de humor da torcida (para gráficos e para explicar ao jogador o porquê)
CREATE TABLE fan_mood_log (
  id         BIGSERIAL PRIMARY KEY,
  club_id    INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  delta      INT NOT NULL,
  reason     TEXT NOT NULL,              -- "Vitória no clássico", "Ingresso caro", "Vendeu ídolo"
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Ações de marketing para ganhar torcedores (catálogo em sim/fans.ts)
CREATE TABLE marketing_campaigns (
  id             SERIAL PRIMARY KEY,
  club_id        INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  kind           campaign_kind NOT NULL,
  cost_per_round BIGINT NOT NULL,
  start_round    INT NOT NULL,
  end_round      INT,                       -- NULL = contínua (projeto social)
  active         BOOLEAN NOT NULL DEFAULT true
);
-- uma campanha de cada tipo ativa por vez
CREATE UNIQUE INDEX one_campaign_per_kind ON marketing_campaigns (club_id, kind) WHERE active;

-- Evolução da torcida por rodada, com o motivo de cada ganho/perda (JSON do breakdown)
CREATE TABLE fan_history (
  club_id    INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  season     INT NOT NULL,
  round      INT NOT NULL,
  fan_base   INT NOT NULL,
  members    INT NOT NULL,
  fan_mood   INT NOT NULL,
  breakdown  JSONB NOT NULL DEFAULT '[]',
  PRIMARY KEY (club_id, season, round)
);

-- ---------------------------------------------------------------------
-- JOGADORES
-- ---------------------------------------------------------------------
CREATE TABLE players (
  id            SERIAL PRIMARY KEY,
  world_id      INT  NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  club_id       INT  REFERENCES clubs(id),          -- NULL = sem clube (livre)
  name          TEXT NOT NULL,
  birth_season  INT  NOT NULL,                      -- idade = current_season - birth_season + 16
  nationality   TEXT NOT NULL DEFAULT 'BRA',
  position      position_t NOT NULL,
  foot          foot_t NOT NULL DEFAULT 'D',
  -- atributos 1..100
  pace          INT NOT NULL CHECK (pace       BETWEEN 1 AND 100),
  stamina       INT NOT NULL CHECK (stamina    BETWEEN 1 AND 100),
  strength      INT NOT NULL CHECK (strength   BETWEEN 1 AND 100),
  passing       INT NOT NULL CHECK (passing    BETWEEN 1 AND 100),
  dribbling     INT NOT NULL CHECK (dribbling  BETWEEN 1 AND 100),
  finishing     INT NOT NULL CHECK (finishing  BETWEEN 1 AND 100),
  defending     INT NOT NULL CHECK (defending  BETWEEN 1 AND 100),
  heading       INT NOT NULL CHECK (heading    BETWEEN 1 AND 100),
  goalkeeping   INT NOT NULL CHECK (goalkeeping BETWEEN 1 AND 100),
  vision        INT NOT NULL CHECK (vision     BETWEEN 1 AND 100),
  -- ocultos / estado
  potential     INT NOT NULL CHECK (potential  BETWEEN 1 AND 100), -- teto de evolução
  form          INT NOT NULL DEFAULT 50 CHECK (form    BETWEEN 0 AND 100),
  fitness       INT NOT NULL DEFAULT 100 CHECK (fitness BETWEEN 0 AND 100),
  morale        INT NOT NULL DEFAULT 60 CHECK (morale  BETWEEN 0 AND 100),
  popularity    INT NOT NULL DEFAULT 10 CHECK (popularity BETWEEN 0 AND 100), -- ídolo? vender irrita a torcida
  injured_until_round INT,                          -- NULL = saudável
  suspended_rounds    INT NOT NULL DEFAULT 0,
  is_youth      BOOLEAN NOT NULL DEFAULT false,     -- está na divisão de base
  market_value  BIGINT NOT NULL DEFAULT 0,          -- recalculado pelo worker
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON players (club_id);
CREATE INDEX ON players (world_id, position);

CREATE TABLE player_contracts (
  id             SERIAL PRIMARY KEY,
  player_id      INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  club_id        INT NOT NULL REFERENCES clubs(id),
  weekly_salary  BIGINT NOT NULL CHECK (weekly_salary >= 0),
  release_clause BIGINT,                        -- multa rescisória
  start_season   INT NOT NULL,
  end_season     INT NOT NULL,
  status         contract_status NOT NULL DEFAULT 'ATIVO',
  CHECK (end_season >= start_season)
);
-- só um contrato ativo por jogador
CREATE UNIQUE INDEX one_active_player_contract ON player_contracts (player_id) WHERE status = 'ATIVO';

-- Escalação salva pelo usuário para a próxima partida
CREATE TABLE lineups (
  club_id    INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  player_id  INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  slot       INT NOT NULL CHECK (slot BETWEEN 1 AND 18),  -- 1-11 titulares, 12-18 reservas
  role       position_t NOT NULL,
  PRIMARY KEY (club_id, slot),
  UNIQUE (club_id, player_id)
);

-- ---------------------------------------------------------------------
-- COMISSÃO TÉCNICA / STAFF (técnico, médicos, preparadores...)
-- ---------------------------------------------------------------------
CREATE TABLE staff (
  id          SERIAL PRIMARY KEY,
  world_id    INT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  role        staff_role_t NOT NULL,
  skill       INT NOT NULL CHECK (skill BETWEEN 1 AND 100),       -- competência geral
  -- especializações (usadas conforme o papel)
  tactics     INT NOT NULL DEFAULT 50 CHECK (tactics    BETWEEN 1 AND 100),
  motivation  INT NOT NULL DEFAULT 50 CHECK (motivation BETWEEN 1 AND 100),
  youth_dev   INT NOT NULL DEFAULT 50 CHECK (youth_dev  BETWEEN 1 AND 100),
  reputation  INT NOT NULL DEFAULT 30 CHECK (reputation BETWEEN 1 AND 100)
);
CREATE INDEX ON staff (world_id, role);

CREATE TABLE staff_contracts (
  id               SERIAL PRIMARY KEY,
  staff_id         INT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  club_id          INT NOT NULL REFERENCES clubs(id),
  weekly_salary    BIGINT NOT NULL,
  start_season     INT NOT NULL,
  end_season       INT NOT NULL,
  termination_fee  BIGINT NOT NULL DEFAULT 0,   -- multa paga ao demitir
  status           contract_status NOT NULL DEFAULT 'ATIVO'
);
CREATE UNIQUE INDEX one_active_staff_contract ON staff_contracts (staff_id) WHERE status = 'ATIVO';

-- ---------------------------------------------------------------------
-- PATROCÍNIOS
-- ---------------------------------------------------------------------
CREATE TABLE sponsors (
  id              SERIAL PRIMARY KEY,
  world_id        INT  NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                 -- nomes fictícios
  slot            TEXT NOT NULL,                 -- 'MASTER','MANGA','COSTAS','ESTADIO','MATERIAL'
  min_reputation  INT  NOT NULL DEFAULT 1        -- só oferece para clubes acima disso
);

CREATE TABLE sponsorship_contracts (
  id              SERIAL PRIMARY KEY,
  sponsor_id      INT NOT NULL REFERENCES sponsors(id),
  club_id         INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  slot            TEXT NOT NULL,
  per_round       BIGINT NOT NULL,           -- pagamento fixo por rodada
  bonus_per_win   BIGINT NOT NULL DEFAULT 0,
  start_season    INT NOT NULL,
  end_season      INT NOT NULL,
  break_fee       BIGINT NOT NULL DEFAULT 0, -- multa se o CLUBE romper
  status          contract_status NOT NULL DEFAULT 'ATIVO'
);
-- um patrocinador ativo por espaço na camisa/estádio
CREATE UNIQUE INDEX one_sponsor_per_slot ON sponsorship_contracts (club_id, slot) WHERE status = 'ATIVO';

-- Ofertas que aparecem para o usuário aceitar/recusar
CREATE TABLE sponsorship_offers (
  id           SERIAL PRIMARY KEY,
  sponsor_id   INT NOT NULL REFERENCES sponsors(id),
  club_id      INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  slot         TEXT NOT NULL,
  per_round    BIGINT NOT NULL,
  bonus_per_win BIGINT NOT NULL DEFAULT 0,
  seasons      INT NOT NULL DEFAULT 1,
  break_fee    BIGINT NOT NULL DEFAULT 0,
  status       offer_status NOT NULL DEFAULT 'PENDENTE',
  expires_round INT NOT NULL
);

-- ---------------------------------------------------------------------
-- INSTALAÇÕES: ESTÁDIO, CT, BASE, DEPARTAMENTO MÉDICO
-- ---------------------------------------------------------------------
CREATE TABLE facilities (
  club_id     INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  type        facility_t NOT NULL,
  level       INT NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 10),
  condition   INT NOT NULL DEFAULT 100 CHECK (condition BETWEEN 0 AND 100), -- cai com o tempo; reforma recupera
  maintenance_per_round BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (club_id, type)
);

-- Setores do estádio: capacidade e preço do ingresso definido pelo usuário
CREATE TABLE stadium_sectors (
  club_id      INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  sector       sector_t NOT NULL,
  capacity     INT NOT NULL CHECK (capacity >= 0),
  ticket_price BIGINT NOT NULL CHECK (ticket_price >= 0),
  comfort      INT NOT NULL DEFAULT 50 CHECK (comfort BETWEEN 1 AND 100),
  PRIMARY KEY (club_id, sector)
);

-- Obras: construir setor novo, ampliar, reformar, subir nível do CT...
CREATE TABLE construction_projects (
  id             SERIAL PRIMARY KEY,
  club_id        INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  facility       facility_t NOT NULL,
  kind           TEXT NOT NULL,           -- 'AMPLIAR_SETOR','REFORMA','SUBIR_NIVEL','NOVO_SETOR'
  target_sector  sector_t,                -- quando for no estádio
  amount         INT,                     -- ex.: +5000 lugares
  total_cost     BIGINT NOT NULL,
  paid           BIGINT NOT NULL DEFAULT 0,
  start_round    INT NOT NULL,
  finish_round   INT NOT NULL,
  -- durante obra no estádio, parte da capacidade fica indisponível
  capacity_blocked INT NOT NULL DEFAULT 0,
  status         project_status NOT NULL DEFAULT 'EM_ANDAMENTO'
);
-- só uma obra por instalação ao mesmo tempo
CREATE UNIQUE INDEX one_project_per_facility ON construction_projects (club_id, facility) WHERE status = 'EM_ANDAMENTO';

-- ---------------------------------------------------------------------
-- TREINAMENTO
-- ---------------------------------------------------------------------
-- Plano coletivo semanal do clube (soma das intensidades = 100)
CREATE TABLE team_training (
  club_id     INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  focus       training_focus NOT NULL,
  intensity   INT NOT NULL CHECK (intensity BETWEEN 0 AND 100),
  PRIMARY KEY (club_id, focus)
);

-- Treino individual: um foco por jogador, sobrepõe parte do coletivo
CREATE TABLE individual_training (
  player_id   INT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  attribute   TEXT NOT NULL CHECK (attribute IN
                ('pace','stamina','strength','passing','dribbling','finishing',
                 'defending','heading','goalkeeping','vision')),
  intensity   INT NOT NULL DEFAULT 50 CHECK (intensity BETWEEN 1 AND 100)
);

-- Progresso fracionário: atributos só sobem 1 ponto quando acumulam 1.0
CREATE TABLE training_progress (
  player_id  INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  attribute  TEXT NOT NULL,
  progress   NUMERIC(6,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (player_id, attribute)
);

-- ---------------------------------------------------------------------
-- DIVISÃO DE BASE
-- ---------------------------------------------------------------------
-- Jogadores da base ficam em `players` com is_youth = true.
-- Esta tabela registra as "peneiras"/intakes de cada temporada.
CREATE TABLE youth_intakes (
  id          SERIAL PRIMARY KEY,
  club_id     INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  season      INT NOT NULL,
  round       INT NOT NULL,
  players_generated INT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- MERCADO DE TRANSFERÊNCIAS (entre usuários e com a IA)
-- ---------------------------------------------------------------------
CREATE TABLE transfer_listings (
  id           SERIAL PRIMARY KEY,
  player_id    INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  seller_club  INT NOT NULL REFERENCES clubs(id),
  asking_price BIGINT NOT NULL,
  listed_round INT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX one_active_listing ON transfer_listings (player_id) WHERE active;

CREATE TABLE transfer_offers (
  id            SERIAL PRIMARY KEY,
  player_id     INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  from_club     INT NOT NULL REFERENCES clubs(id),     -- comprador
  to_club       INT NOT NULL REFERENCES clubs(id),     -- vendedor
  amount        BIGINT NOT NULL CHECK (amount > 0),
  offered_salary BIGINT NOT NULL,                      -- salário proposto ao jogador
  contract_seasons INT NOT NULL DEFAULT 3,
  status        offer_status NOT NULL DEFAULT 'PENDENTE',
  created_round INT NOT NULL,
  expires_round INT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_club <> to_club)
);
CREATE INDEX ON transfer_offers (to_club, status);
CREATE INDEX ON transfer_offers (from_club, status);

-- Histórico de transferências concluídas
CREATE TABLE transfers (
  id         SERIAL PRIMARY KEY,
  player_id  INT NOT NULL REFERENCES players(id),
  from_club  INT REFERENCES clubs(id),
  to_club    INT REFERENCES clubs(id),
  amount     BIGINT NOT NULL,
  season     INT NOT NULL,
  round      INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- CALENDÁRIO E PARTIDAS
-- ---------------------------------------------------------------------
CREATE TABLE matches (
  id            SERIAL PRIMARY KEY,
  world_id      INT NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
  division_id   INT REFERENCES divisions(id),
  season        INT NOT NULL,
  round         INT NOT NULL,
  home_club     INT NOT NULL REFERENCES clubs(id),
  away_club     INT NOT NULL REFERENCES clubs(id),
  home_goals    INT,
  away_goals    INT,
  attendance    INT,
  gate_revenue  BIGINT,
  seed          BIGINT NOT NULL DEFAULT (floor(random() * 2147483647))::BIGINT, -- reprodutível
  status        match_status NOT NULL DEFAULT 'AGENDADA',
  CHECK (home_club <> away_club)
);
CREATE INDEX ON matches (world_id, season, round);

CREATE TABLE match_events (
  id         BIGSERIAL PRIMARY KEY,
  match_id   INT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  minute     INT NOT NULL,
  club_id    INT REFERENCES clubs(id),
  player_id  INT REFERENCES players(id),
  type       event_t NOT NULL,
  text       TEXT NOT NULL
);
CREATE INDEX ON match_events (match_id, minute);

-- Classificação materializada (atualizada pelo worker após cada rodada)
CREATE TABLE standings (
  division_id INT NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  season      INT NOT NULL,
  club_id     INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  played INT NOT NULL DEFAULT 0, won INT NOT NULL DEFAULT 0, drawn INT NOT NULL DEFAULT 0,
  lost   INT NOT NULL DEFAULT 0, gf  INT NOT NULL DEFAULT 0, ga    INT NOT NULL DEFAULT 0,
  points INT NOT NULL DEFAULT 0,
  PRIMARY KEY (division_id, season, club_id)
);

-- ---------------------------------------------------------------------
-- FINANÇAS (livro-caixa — nunca altere `balance` sem lançar aqui)
-- ---------------------------------------------------------------------
CREATE TABLE ledger (
  id          BIGSERIAL PRIMARY KEY,
  club_id     INT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
  season      INT NOT NULL,
  round       INT NOT NULL,
  type        ledger_t NOT NULL,
  amount      BIGINT NOT NULL,          -- positivo = entrada, negativo = saída
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger (club_id, season, round);

-- Função única para mexer no caixa: lança no livro e atualiza o saldo atomicamente.
CREATE OR REPLACE FUNCTION post_ledger(p_club INT, p_type ledger_t, p_amount BIGINT, p_desc TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE s INT; r INT;
BEGIN
  SELECT w.current_season, w.current_round INTO s, r
  FROM clubs c JOIN worlds w ON w.id = c.world_id WHERE c.id = p_club;
  INSERT INTO ledger (club_id, season, round, type, amount, description)
  VALUES (p_club, s, r, p_type, p_amount, p_desc);
  UPDATE clubs SET balance = balance + p_amount WHERE id = p_club;
END $$;

-- ---------------------------------------------------------------------
-- TRANSFERÊNCIA ATÔMICA
-- Aceitar uma proposta: trava as linhas (FOR UPDATE) para que duas
-- aceitações simultâneas do mesmo jogador não aconteçam.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accept_transfer_offer(p_offer INT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  o transfer_offers%ROWTYPE;
  buyer_balance BIGINT;
  cur_club INT;
  s INT; r INT;
BEGIN
  SELECT * INTO o FROM transfer_offers WHERE id = p_offer FOR UPDATE;
  IF o.status <> 'PENDENTE' THEN
    RAISE EXCEPTION 'Proposta % não está pendente', p_offer;
  END IF;

  SELECT club_id INTO cur_club FROM players WHERE id = o.player_id FOR UPDATE;
  IF cur_club IS DISTINCT FROM o.to_club THEN
    RAISE EXCEPTION 'Jogador não pertence mais ao clube vendedor';
  END IF;

  -- trava os dois clubes em ordem de id para evitar deadlock
  PERFORM 1 FROM clubs WHERE id IN (o.from_club, o.to_club) ORDER BY id FOR UPDATE;
  SELECT balance INTO buyer_balance FROM clubs WHERE id = o.from_club;
  IF buyer_balance < o.amount THEN
    RAISE EXCEPTION 'Comprador sem saldo suficiente';
  END IF;

  SELECT w.current_season, w.current_round INTO s, r
  FROM clubs c JOIN worlds w ON w.id = c.world_id WHERE c.id = o.to_club;

  PERFORM post_ledger(o.from_club, 'COMPRA_JOGADOR', -o.amount, 'Compra do jogador #' || o.player_id);
  PERFORM post_ledger(o.to_club,   'VENDA_JOGADOR',   o.amount, 'Venda do jogador #'  || o.player_id);

  UPDATE player_contracts SET status = 'ENCERRADO' WHERE player_id = o.player_id AND status = 'ATIVO';
  INSERT INTO player_contracts (player_id, club_id, weekly_salary, start_season, end_season)
  VALUES (o.player_id, o.from_club, o.offered_salary, s, s + o.contract_seasons - 1);

  UPDATE players SET club_id = o.from_club, is_youth = false WHERE id = o.player_id;
  DELETE FROM lineups WHERE player_id = o.player_id;
  DELETE FROM individual_training WHERE player_id = o.player_id;
  UPDATE transfer_listings SET active = false WHERE player_id = o.player_id AND active;

  UPDATE transfer_offers SET status = 'ACEITA' WHERE id = o.id;
  -- outras propostas pelo mesmo jogador caem
  UPDATE transfer_offers SET status = 'CANCELADA'
   WHERE player_id = o.player_id AND status = 'PENDENTE' AND id <> o.id;

  INSERT INTO transfers (player_id, from_club, to_club, amount, season, round)
  VALUES (o.player_id, o.to_club, o.from_club, o.amount, s, r);
END $$;

-- ---------------------------------------------------------------------
-- DEMITIR STAFF (paga multa e encerra contrato)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fire_staff(p_contract INT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE c staff_contracts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM staff_contracts WHERE id = p_contract FOR UPDATE;
  IF c.status <> 'ATIVO' THEN RAISE EXCEPTION 'Contrato não está ativo'; END IF;
  PERFORM post_ledger(c.club_id, 'MULTA_RESCISAO', -c.termination_fee, 'Demissão de staff #' || c.staff_id);
  UPDATE staff_contracts SET status = 'RESCINDIDO' WHERE id = c.id;
END $$;

-- ---------------------------------------------------------------------
-- ROMPER PATROCÍNIO (paga multa, torcida/reputação podem reagir no app)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION break_sponsorship(p_contract INT)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE c sponsorship_contracts%ROWTYPE;
BEGIN
  SELECT * INTO c FROM sponsorship_contracts WHERE id = p_contract FOR UPDATE;
  IF c.status <> 'ATIVO' THEN RAISE EXCEPTION 'Contrato não está ativo'; END IF;
  PERFORM post_ledger(c.club_id, 'MULTA_RESCISAO', -c.break_fee, 'Rompimento de patrocínio #' || c.sponsor_id);
  UPDATE sponsorship_contracts SET status = 'RESCINDIDO' WHERE id = c.id;
END $$;

-- ---------------------------------------------------------------------
-- VIEW: idade dos jogadores
-- ---------------------------------------------------------------------
CREATE VIEW players_with_age AS
SELECT p.*, (w.current_season - p.birth_season + 16) AS age
FROM players p JOIN worlds w ON w.id = p.world_id;
