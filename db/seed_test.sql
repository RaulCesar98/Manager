-- Teste rápido das funções transacionais
INSERT INTO worlds (name, settings) VALUES ('Mundo 1', '{}');
INSERT INTO divisions (world_id, name, tier) VALUES (1, 'Série A', 1);
INSERT INTO users (email, username, password_hash) VALUES ('a@x.com','ana','h'), ('b@x.com','bia','h');
INSERT INTO clubs (world_id, division_id, owner_user_id, name, short_name, balance)
SELECT 1, 1, id, CASE username WHEN 'ana' THEN 'Tigres FC' ELSE 'Águias EC' END,
       CASE username WHEN 'ana' THEN 'TIG' ELSE 'AGU' END, 50000000 FROM users;
INSERT INTO players (world_id, club_id, name, birth_season, position, pace, stamina, strength, passing,
  dribbling, finishing, defending, heading, goalkeeping, vision, potential, popularity)
VALUES (1, 1, 'Craque', -2, 'ATA', 80, 70, 65, 68, 78, 82, 30, 60, 10, 70, 85, 60);
INSERT INTO player_contracts (player_id, club_id, weekly_salary, start_season, end_season) VALUES (1, 1, 2000000, 1, 3);
INSERT INTO transfer_offers (player_id, from_club, to_club, amount, offered_salary, created_round, expires_round)
VALUES (1, 2, 1, 30000000, 2500000, 0, 3), (1, 2, 1, 1000, 100, 0, 3);
SELECT accept_transfer_offer(1);
SELECT name, club_id FROM players;
SELECT id, status FROM transfer_offers ORDER BY id;
SELECT name, balance/100 AS saldo_reais FROM clubs ORDER BY id;
SELECT club_id, type, amount/100 AS reais FROM ledger ORDER BY id;
-- deve falhar: proposta já cancelada
DO $$ BEGIN PERFORM accept_transfer_offer(2); EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'OK, bloqueado: %', SQLERRM; END $$;
-- staff e patrocínio
INSERT INTO staff (world_id, name, role, skill) VALUES (1, 'Prof. Silva', 'TECNICO', 70);
INSERT INTO staff_contracts (staff_id, club_id, weekly_salary, start_season, end_season, termination_fee) VALUES (1, 1, 500000, 1, 2, 3000000);
SELECT fire_staff(1);
INSERT INTO sponsors (world_id, name, slot) VALUES (1, 'Banco Fictício', 'MASTER');
INSERT INTO sponsorship_contracts (sponsor_id, club_id, slot, per_round, start_season, end_season, break_fee) VALUES (1, 1, 'MASTER', 800000, 1, 2, 5000000);
SELECT break_sponsorship(1);
SELECT name, balance/100 AS saldo_final FROM clubs WHERE id = 1;
SELECT name, age FROM players_with_age;
