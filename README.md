# Football Manager Multiplayer — base do projeto

Banco (PostgreSQL) + motor de simulação (TypeScript, sem dependências em tempo de execução).
Tudo é **fictício**: clubes, jogadores, técnicos e patrocinadores são gerados.
Só os nomes das cidades são reais.

## Jogar no seu computador

Precisa só do **Node 22.6 ou mais novo** (o 24 serve). Nada para instalar.

- **Windows:** dê dois cliques em `jogar.bat`. O navegador abre em http://localhost:3000.
- **Qualquer sistema:** `node --experimental-strip-types server/main.ts --abrir`

Crie uma conta, clique em **Criar sala**, escolha seu clube e jogue. Contas e salas ficam
salvas na pasta `dados/` (apague a pasta para começar do zero). Para jogar com alguém na
mesma rede, ele abre `http://IP-DO-SEU-PC:3000` e entra com o código da sala.

O que já dá para fazer: criar sala (solo ou multiplayer), escolher clube, escalar o time
no campinho (formação, mentalidade, titulares e reservas), ordenar o elenco por qualquer
coluna, ver o calendário da temporada, jogar rodadas ao vivo com os placares de todos os
jogos (clique no seu jogo para substituir ou mudar a postura sem parar a partida), ver
tabela e resultados, acompanhar torcida e finanças, ativar ações de marketing e jogar
várias temporadas com acesso e rebaixamento.

**Caixa de mensagens e contratos:** chegam avisos de lesões, suspensões, humor da torcida,
propostas de patrocínio e contratos terminando. Renovações e patrocínios são negociados
(`server/office.ts`): a outra parte tem um limite escondido, começa firme e cede a cada
contraproposta; cada contraproposta gasta paciência, e oferta ofensiva gasta o dobro.
Jogador sem renovação sai de graça na virada da temporada; patrocínio vencido libera o espaço.

**Mercado:** busca com filtros (nome, posição, idade, força, valor, característica, divisão,
à venda, livres). Jogador livre: negocia o salário. Jogador da IA: negocia o passe com o
clube e depois o salário; o passe só é pago quando ele assina. Jogador de outro técnico:
compra pelo preço pedido ou manda proposta pela caixa de mensagens. Seus jogadores à venda
recebem ofertas da IA com frequência, e até 3 clubes podem disputar o mesmo jogador (a
disputa sobe a oferta). A IA também faz propostas surpresa por quem não está à venda, mirando
os melhores e os que estão jogando bem, com ágio de 15% a 100% sobre o valor de mercado.
Valem a janela de transferências, o elenco máximo e o bloqueio de gastos com caixa negativo.
Valor de mercado ≈ 2,5 temporadas de salário, por idade e potencial.

**Empréstimos (`server/loans.ts`):** pela ficha do jogador, peça emprestado até o fim desta
temporada ou da próxima. Combine quanto do salário cada clube paga (0%, 25%, 50%, 75% ou
100% para quem recebe), uma taxa de empréstimo e, se quiser, uma compra com valor pré-fixado
ligada a uma meta (jogos, gols ou nota média). A compra pode ser opcional (bateu a meta, quem
recebeu compra quando quiser) ou obrigatória (bateu a meta, a compra acontece sozinha no fim
do empréstimo). Clubes da IA respondem na hora e dão uma dica do que falta; aceitam até 3
tentativas por jogador e temporada. Marque seus jogadores como disponíveis para empréstimo e
a IA manda pedidos (às vezes também por jovens que jogam pouco); você aceita, recusa ou faz
contraproposta. Entre técnicos, o dono aceita ou recusa. O quadro "Empréstimos", no Mercado,
mostra pedidos, jogadores cedidos e recebidos e o andamento das metas.

**Tabela:** classificação, artilheiros e seleção do campeonato (4-3-3 pela média das notas,
com mínimo de jogos de 40% das rodadas).

**Capitão:** escolhido na escalação entre os titulares. Em campo, dá até +3% de força ao time
conforme a liderança (idade e popularidade). Se sair, a faixa passa para o maior líder em campo.
Melhor líder em vez do pior ≈ +2,5 pontos numa temporada de 38 rodadas.

**Torcida (`server/crowd.ts`):** o humor (0 a 100) muda o comportamento da torcida. Abaixo de
25 ela vaia o time em casa (−3% de força). Abaixo de 30 há risco de agressão a jogadores
(4% a 26% por rodada; pode lesionar, derruba a moral do elenco e a reputação). Abaixo de 20 há
risco de invasão ao CT (3% a 20%; conservação do CT cai, conserto custa caro, treino suspenso).
Derrota na rodada aumenta esses riscos em 50%; vitória os reduz pela metade. Acima de 65 vêm o
apoio (treino aberto lotado, festa no aeroporto: moral e forma sobem) e os mosaicos nos jogos
em casa (+3% de força); acima de 80 e em clássicos eles ficam frequentes. O mosaico é desenhado
com as cores do clube (sigla, escudo, listras, estrelas ou diagonal), cartão por cartão, e
aparece na mensagem e no quadro "Torcida" do Início, com as chances da próxima rodada.
Agressões e invasões só acontecem com clubes de técnicos.

**Efeitos sonoros (`web/sons.js`):** gerados na hora com Web Audio, sem arquivos de áudio.
Na partida ao vivo: apito inicial, de intervalo e final; explosão da torcida e corneta nos gols
do seu time, lamento nos gols sofridos, "plim" discreto nos gols de outros jogos da divisão,
apito no amarelo, som de expulsão e de lesão. Mosaico no seu estádio toca batucada com palmas
(e aparece na tela da partida); vaia toca "uuuu". Fora do jogo: caixa registradora em negócio
fechado, som de recusa, marteladas ao iniciar obra, fanfarra ao promover jovem, sirene em
invasão ao CT e aviso de mensagem nova. O botão "Som" no topo liga/desliga e tem volume
(fica salvo no navegador). O navegador só libera o som depois do primeiro clique na página.

**Ranking de torcidas** (aba Tabela): todos os clubes ordenados pelo número de torcedores, com
crescimento na temporada, humor, sócios, público médio (e ocupação), mosaicos da temporada e
reputação. Filtra por divisão, ordena por qualquer coluna e mostra a sua posição no geral, na
divisão e em crescimento.

**Rodada ao vivo:** o servidor avança os jogos conforme o relógio (velocidade da sala).
Substituições e mudanças de postura entram no minuto em que são feitas e ficam gravadas;
se o servidor reiniciar no meio da rodada, os jogos são reconstruídos iguais (mesma
semente + mesmas ações nos mesmos minutos). Na velocidade instantânea, a rodada sai de uma vez.

**Estádio (`server/club.ts`):** preço do ingresso por setor, com prévia do público e da renda
do próximo jogo em casa enquanto você digita (até 6× o preço justo; caro demais irrita a
torcida). Ampliação por setor (até 90 mil lugares) e obras de nível/reforma em estádio, CT,
base e departamento médico. Obras são pagas em parcelas por rodada, levam várias rodadas e
fecham parte dos lugares. O mapa do clube mostra estádio (setores clicáveis para ampliar),
CT, base e departamento médico; clique para ver nível, conservação e iniciar obras.
Cada instalação perde ~1 ponto de conservação a cada 2 rodadas;
estádio malconservado afasta público. CT acelera a evolução, departamento médico soma até +25
ao médico e ao fisioterapeuta.

**Evolução:** todo jogador treina toda semana (plano padrão). Por temporada, em média:
15–17 anos +3, 18–20 +2,5, 21–23 +1, 24–29 estável, 30–32 −0,5, 33+ −2. O ritmo é por
temporada, seja ela curta ou longa.

**Divisão de base:** peneira no início de cada temporada (jovens de 15 a 17 anos) e uma
peneira extra paga por temporada. O potencial aparece como faixa estimada pelo treinador da
base. Promover leva ao elenco profissional (contrato de 3 temporadas); aos 20 anos, quem não
foi promovido deixa o clube. Máximo de 24 jovens.

Ainda não: contratar/demitir staff e escolher o treino (coletivo e individual).

## Arquivos

```
server/main.ts           servidor HTTP + API (sem dependências)
server/engine.ts         regras do jogo: salas, escalação, rodadas, temporadas
server/office.ts         caixa de mensagens, negociações (renovação, patrocínio, passe, venda), fim de contratos
server/market.ts         mercado: busca, ficha, compra, venda, propostas entre técnicos, janela
server/loans.ts          empréstimos: divisão de salário, taxa, compra pré-fixada por meta
server/crowd.ts          torcida pelo humor: vaias, agressões, invasão ao CT, apoio, mosaicos
web/sons.js              efeitos sonoros (Web Audio, sem arquivos de áudio)
server/club.ts           estádio (ingressos, obras), instalações, divisão de base, evolução semanal
server/store.ts          salvamento em arquivos JSON (troque por PostgreSQL para hospedar)
web/index.html           login, cadastro e minhas salas
web/jogo.html            o jogo: início, escalação, tabela, resultados, torcida, sala
web/criar-sala.html      criação de sala com todas as regras
web/base.css, comum.js   estilo e funções comuns (tema claro/escuro)
jogar.bat                atalho para Windows
db/schema.sql            tabelas, índices e funções transacionais (salas, clubes, torcida, mercado...)
db/seed_test.sql         teste rápido das funções (transferência, demissão, patrocínio)
sim/settings.ts          configurações da sala: regras, preparação, dificuldade, velocidade + "todos prontos"
sim/worldgen.ts          gera o mundo: cidades, clubes, elencos, staff, patrocínios, estádios, tabela
sim/names.ts             listas de nomes, cidades e bloqueio de nomes de clubes reais
sim/fans.ts              torcida: crescimento, campanhas, sócio-torcedor, valor de patrocínio
sim/importexport.ts      patches da comunidade (JSON e CSV) — importar e exportar
sim/tosql.ts             converte um mundo gerado em script SQL
sim/match.ts             partida minuto a minuto (respeita regras e dificuldade da sala)
sim/economy.ts           público, bilheteria, humor, manutenção, valor de mercado
sim/training.ts          treino coletivo e individual
sim/youth.ts             peneira da base
sim/strength.ts          atributos -> força por setor
sim/demo.ts              calibragem do motor de partida
sim/demo-temporada.ts    temporada completa: torcida, finanças e regras da sala
sim/cli-gerar.ts         gera mundos pela linha de comando
web/criar-sala.html      tela de criação de sala (protótipo funcional)
exemplos/                patch e CSV de exemplo
```

## Rodar

```bash
npm i                                   # só ferramentas de desenvolvimento (typescript, @types/node)
createdb fm && psql -d fm -f db/schema.sql

npm run gerar -- --seed 42 --divisoes 2 --clubes 20 --sql mundo.sql
psql -d fm -f mundo.sql                 # cria a sala; pode rodar várias vezes no mesmo banco

npm run temporada                       # simula uma temporada e mostra torcida e finanças
npm run demo                            # calibragem das partidas
npm run typecheck
```

Opções do gerador: `--dificuldade FACIL|NORMAL|DIFICIL|LENDARIO`, `--patch arquivo.json`,
`--csv jogadores.csv`, `--exportar patch.json`, `--exportar-csv jogadores.csv`.

## Configurações da sala (`sim/settings.ts`)

O dono da sala edita tudo no lobby (veja `web/criar-sala.html`). O JSON fica em `worlds.settings`.

| Grupo | O que controla |
|---|---|
| Estrutura | divisões (1–4), clubes por divisão, quantos sobem/descem, onde os humanos começam |
| Regras | substituições (3 ou 5), elenco mínimo/máximo, janelas de transferência, teto salarial, fair play financeiro, lesões, peneira da base |
| Preparação | **tempo limite** entre rodadas (1 min a 24 h, ou sem limite), espera mínima, quando parar de esperar quem some (AFK) |
| Velocidade | instantânea, rápida (~40 s), normal (~2 min) ou lenta (~4,5 min) por jogo ao vivo |
| Dificuldade | caixa inicial, força da IA, valor dos patrocínios, ganho de torcida, cobrança da torcida, lesões, salários pedidos |

- **Todos prontos:** a rodada roda quando todos os técnicos ativos clicam em "Pronto"
  (tabela `round_ready`), depois da espera mínima. Se o **tempo limite** acabar, roda mesmo
  assim, e quem não confirmou joga com a última escalação salva (ou a automática).
- **AFK:** quem perde o prazo N vezes seguidas (`room_members.missed_in_a_row`) vira AFK e a
  sala para de esperar por ele. Volta a ser esperado assim que clicar em "Pronto".
  Com "sem limite", a sala sempre espera todos.
- A decisão fica em `decideRound()`; os contadores, em `updateAfk()`.
- **Velocidade** não muda o resultado. O servidor simula na hora; o navegador revela os
  eventos no ritmo escolhido com `eventRevealAt()`. A preparação começa quando a exibição
  termina (`liveDurationMs()`).
- Preparação, nome e velocidade podem mudar com a temporada em andamento. Estrutura, regras
  e dificuldade vão para `pending_settings` e valem na temporada seguinte.

## Torcida (`sim/fans.ts`)

O número de torcedores é o que define o valor dos contratos. Formas de ganhar torcida:

| Fonte | Efeito |
|---|---|
| Resultados | vitória, sequência de vitórias, clássico vale o dobro; título +8%, acesso +4%, rebaixamento −5% |
| Estádio | casa cheia atrai; ingresso popular atrai, caro afasta |
| Humor | torcida animada traz gente; insatisfeita abandona |
| Ídolos e base | jogadores populares e crias da base no time titular |
| Marketing | redes sociais, TV e rádio, visitas a escolas, amistoso em outra cidade, projeto social, ingresso infantil solidário |

Cada cidade tem um **teto de mercado** dividido entre os clubes dela, ampliado pela
reputação nacional. Perto do teto, crescer fica difícil. Escolas e projetos sociais criam
**fidelidade**: a torcida perde menos gente nas fases ruins.

O que a torcida vale em dinheiro: patrocínio (`sponsorValuePerRound`), sócio-torcedor
(`updateMembers`), produtos (`merchandisingPerRound`) e bilheteria.

## Patches da comunidade (`sim/importexport.ts`)

Formato JSON com chaves em português (exemplo em `exemplos/patch-minimo.json`):
clubes com nome, sigla, cidade, divisão e, opcionalmente, reputação, torcida e estádio;
jogadores com nome, clube (sigla), posição, idade e os 10 atributos. O que não vier no
patch é gerado. CSV de jogadores com separador `;` ou `,` (exemplo em
`exemplos/jogadores-minimo.csv`). Os erros saem por linha, em português.

Isso permite que a própria comunidade crie patches com os nomes que quiser, sem que o
jogo distribua nomes reais.

## Regras importantes do banco

- **Dinheiro em centavos** (`BIGINT`). Nunca use `float`.
- **Nunca altere `clubs.balance` direto.** Use `post_ledger()`.
- **Mercado multiplayer:** `accept_transfer_offer()` trava jogador e clubes; duas
  aceitações simultâneas do mesmo jogador não passam.
- Índices únicos parciais: 1 contrato ativo por jogador/staff, 1 patrocinador por espaço,
  1 obra por instalação, 1 campanha de cada tipo, 1 clube por usuário por sala.

## O worker de rodadas

O servidor chama `decideRound()` em dois momentos: quando alguém clica em "Pronto" e num
timer a cada poucos segundos (busca salas com `prep_deadline <= now()`). Se a rodada deve
rodar, numa transação por sala:

1. Trava a sala (`FOR UPDATE`).
2. Escalações (IA monta as que faltarem).
3. `simulateMatch(home, away, seed, { maxSubs, injuries, injuryRate, aiStrength })`.
4. Bilheteria (`computeGate`) e humor (`moodAfterMatch`).
5. Patrocínio por rodada + bônus por vitória.
6. Sócio-torcedor, produtos, salários, manutenção, custo das campanhas.
7. `updateFans()` e grava `fan_history` com o motivo de cada ganho ou perda.
8. Obras, treino, expiração de propostas, classificação, valor de mercado.
9. `updateAfk()` com quem não confirmou; limpa `round_ready`.
10. Envia os eventos aos navegadores (WebSocket). Quando a exibição termina,
    `prep_started_at = now()` e `prep_deadline = now() + tempo limite`.

No fim da temporada: título, acesso e rebaixamento (com efeito na torcida), peneira da
base, fim de contratos, nova tabela e aplicação de `pending_settings`.

## Calibragem atual

Partidas (3.000 jogos por linha):

| Confronto | Mandante | Empate | Visitante | Gols/jogo |
|---|---|---|---|---|
| Times iguais (65 x 65) | 45% | 26% | 29% | 2,50 |
| Forte em casa (78 x 58) | 91% | 7% | 2% | 3,40 |

Finanças de uma temporada (mundo padrão, sem marketing):

| Divisão | Receita mediana | Folha mediana | Lucro mediano | No prejuízo |
|---|---|---|---|---|
| Série A | R$ 112 mi | R$ 84 mi | +R$ 17 mi | 6 de 20 |
| Série B | R$ 24 mi | R$ 18 mi | ~R$ 0 | 10 de 20 |

Experimento (mesmo clube, mesma semente): investir R$ 5,4 mi em marketing na temporada
rendeu +116 mil torcedores (10,9% contra 2,3%), mais sócios e um patrocínio master
~7% maior na renovação. O retorno vem ao longo das temporadas seguintes.

Os números de ajuste ficam em constantes no topo de cada arquivo. Depois de mexer,
rode `npm run temporada` e `npm run demo` e confira as tabelas.
