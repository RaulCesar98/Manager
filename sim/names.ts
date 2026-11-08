// Dados para gerar um mundo FICTÍCIO.
// Cidades são reais (nome de cidade não é marca), mas clubes, jogadores,
// técnicos e patrocinadores são inventados. A lista REAL_CLUB_NAMES evita
// que uma combinação gerada coincida com um clube de verdade.

export interface CityDef { name: string; state: string; population: number }

// População aproximada (arredondada) — serve só para o tamanho do mercado.
export const CITIES: CityDef[] = [
  { name: 'São Paulo', state: 'SP', population: 11_500_000 },
  { name: 'Rio de Janeiro', state: 'RJ', population: 6_200_000 },
  { name: 'Brasília', state: 'DF', population: 2_800_000 },
  { name: 'Fortaleza', state: 'CE', population: 2_400_000 },
  { name: 'Salvador', state: 'BA', population: 2_400_000 },
  { name: 'Belo Horizonte', state: 'MG', population: 2_300_000 },
  { name: 'Manaus', state: 'AM', population: 2_100_000 },
  { name: 'Curitiba', state: 'PR', population: 1_800_000 },
  { name: 'Recife', state: 'PE', population: 1_500_000 },
  { name: 'Goiânia', state: 'GO', population: 1_400_000 },
  { name: 'Porto Alegre', state: 'RS', population: 1_300_000 },
  { name: 'Belém', state: 'PA', population: 1_300_000 },
  { name: 'Guarulhos', state: 'SP', population: 1_300_000 },
  { name: 'Campinas', state: 'SP', population: 1_100_000 },
  { name: 'São Luís', state: 'MA', population: 1_000_000 },
  { name: 'Maceió', state: 'AL', population: 950_000 },
  { name: 'Campo Grande', state: 'MS', population: 900_000 },
  { name: 'São Gonçalo', state: 'RJ', population: 900_000 },
  { name: 'Teresina', state: 'PI', population: 870_000 },
  { name: 'João Pessoa', state: 'PB', population: 830_000 },
  { name: 'Natal', state: 'RN', population: 750_000 },
  { name: 'Ribeirão Preto', state: 'SP', population: 700_000 },
  { name: 'Uberlândia', state: 'MG', population: 700_000 },
  { name: 'Sorocaba', state: 'SP', population: 690_000 },
  { name: 'Contagem', state: 'MG', population: 620_000 },
  { name: 'Aracaju', state: 'SE', population: 600_000 },
  { name: 'Feira de Santana', state: 'BA', population: 620_000 },
  { name: 'Cuiabá', state: 'MT', population: 650_000 },
  { name: 'Joinville', state: 'SC', population: 610_000 },
  { name: 'Juiz de Fora', state: 'MG', population: 560_000 },
  { name: 'Londrina', state: 'PR', population: 580_000 },
  { name: 'Aparecida de Goiânia', state: 'GO', population: 530_000 },
  { name: 'Niterói', state: 'RJ', population: 480_000 },
  { name: 'Porto Velho', state: 'RO', population: 460_000 },
  { name: 'Florianópolis', state: 'SC', population: 540_000 },
  { name: 'Caxias do Sul', state: 'RS', population: 470_000 },
  { name: 'Macapá', state: 'AP', population: 440_000 },
  { name: 'Vila Velha', state: 'ES', population: 470_000 },
  { name: 'Santos', state: 'SP', population: 420_000 },
  { name: 'Mogi das Cruzes', state: 'SP', population: 450_000 },
  { name: 'Campina Grande', state: 'PB', population: 420_000 },
  { name: 'Maringá', state: 'PR', population: 410_000 },
  { name: 'Jundiaí', state: 'SP', population: 440_000 },
  { name: 'Montes Claros', state: 'MG', population: 410_000 },
  { name: 'Piracicaba', state: 'SP', population: 420_000 },
  { name: 'Pelotas', state: 'RS', population: 330_000 },
  { name: 'Vitória', state: 'ES', population: 330_000 },
  { name: 'Bauru', state: 'SP', population: 380_000 },
  { name: 'Cascavel', state: 'PR', population: 350_000 },
  { name: 'Ponta Grossa', state: 'PR', population: 360_000 },
  { name: 'Blumenau', state: 'SC', population: 360_000 },
  { name: 'Petrolina', state: 'PE', population: 390_000 },
  { name: 'Caruaru', state: 'PE', population: 380_000 },
  { name: 'Uberaba', state: 'MG', population: 340_000 },
  { name: 'Volta Redonda', state: 'RJ', population: 260_000 },
  { name: 'Chapecó', state: 'SC', population: 250_000 },
  { name: 'Criciúma', state: 'SC', population: 220_000 },
  { name: 'Rio Branco', state: 'AC', population: 360_000 },
  { name: 'Boa Vista', state: 'RR', population: 410_000 },
  { name: 'Palmas', state: 'TO', population: 300_000 },
  { name: 'Santarém', state: 'PA', population: 330_000 },
  { name: 'Imperatriz', state: 'MA', population: 270_000 },
  { name: 'Mossoró', state: 'RN', population: 270_000 },
  { name: 'Arapiraca', state: 'AL', population: 240_000 },
  { name: 'Ipatinga', state: 'MG', population: 230_000 },
  { name: 'Passo Fundo', state: 'RS', population: 210_000 },
  { name: 'Dourados', state: 'MS', population: 250_000 },
  { name: 'Anápolis', state: 'GO', population: 400_000 },
  { name: 'Itabuna', state: 'BA', population: 190_000 },
  { name: 'Juazeiro do Norte', state: 'CE', population: 290_000 },
];

// Padrões de nome. {C} = cidade, {M} = mascote, {X} = palavra inventada.
// TODO padrão tem {M} ou {X}: nomes só com tipo + cidade ("Esporte Clube Fulano",
// "Fulano Futebol Clube") coincidem com clubes reais com muita frequência, e nenhuma
// lista de bloqueio cobre todos. A lista REAL_CLUB_NAMES fica como segunda proteção.
export const CLUB_PATTERNS = [
  '{M} {DE} {C}', '{M} {C} FC', 'Associação {X} {DE} {C}', '{X} Futebol Clube',
  'Sociedade Esportiva {X}', 'Clube Atlético {X} {DE} {C}', '{X} {C}', 'Grêmio {X} {DE} {C}',
  '{X} {DE} {C} EC',
];

// Cidades que pedem artigo: "do Rio de Janeiro", "do Recife".
const CITY_PREP: Record<string, string> = { 'Rio de Janeiro': 'do', 'Recife': 'do', 'Rio Branco': 'do', 'Crato': 'do' };
export const cityPrep = (city: string) => CITY_PREP[city] ?? 'de';

// Palavras inventadas/neutras para compor nomes (evite nomes de clubes famosos:
// Cruzeiro, Guarani, Ponte Preta, Ferroviário, Vasco, Fluminense, Comercial, Operário...)
export const NAME_WORDS = [
  'Aurora', 'Horizonte', 'Alvorada', 'Ipê', 'Jequitibá', 'Sol Nascente', 'Vale Azul', 'Cometa',
  'Relâmpago', 'Trovão', 'Ventania', 'Maré Alta', 'Brisa', 'Pedra Branca', 'Lua Cheia', 'Mandacaru',
  'Carnaúba', 'Buriti', 'Araucária', 'Seriema',
];

export const MASCOTS = [
  'Tigres', 'Leões', 'Águias', 'Falcões', 'Lobos', 'Tubarões', 'Jacarés', 'Panteras',
  'Corujas', 'Touros', 'Carcarás', 'Onças', 'Capivaras', 'Tucanos', 'Arraias', 'Bisões',
];

export const STADIUM_PATTERNS = [
  'Estádio Municipal de {C}', 'Arena {C}', 'Estádio do {S}', 'Arena {M}', 'Estádio Parque {C}',
];

// Nomes de clubes REAIS (em minúsculas, sem acento) que o gerador não pode produzir.
// Amplie esta lista se encontrar alguma coincidência.
export const REAL_CLUB_NAMES = new Set([
  'santos futebol clube', 'fortaleza esporte clube', 'londrina esporte clube', 'criciuma esporte clube',
  'joinville esporte clube', 'esporte clube vitoria', 'goias esporte clube', 'esporte clube bahia',
  'cuiaba esporte clube', 'botafogo futebol clube', 'america futebol clube', 'uniao sao joao',
  'operario ferroviario', 'clube atletico mineiro', 'clube atletico paranaense', 'atletico goianiense',
  'esporte clube juventude', 'chapecoense', 'associacao chapecoense de futebol', 'brasilia futebol clube',
  'volta redonda futebol clube', 'ipatinga futebol clube', 'campinense clube', 'sociedade esportiva palmeiras',
  'uniao barbarense', 'esporte clube santo andre', 'esporte clube sao bento', 'macae esporte',
  'manaus futebol clube', 'cascavel clube recreativo', 'caxias do sul', 'sociedade esportiva caxias do sul',
  'esporte clube pelotas', 'clube desportivo brasil', 'real brasilia', 'estrela do norte',
  'nautico capibaribe', 'sport club recife', 'clube do remo', 'paysandu sport club',
]);

export const normalize = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Compara pelo CONJUNTO de palavras: "Esporte Clube Londrina" bate com "Londrina Esporte Clube".
const wordKey = (s: string) => normalize(s).split(/\s+/).filter((w) => w.length > 2).sort().join(' ');
const REAL_KEYS = new Set([...REAL_CLUB_NAMES].map(wordKey));
export const isRealClubName = (name: string) => REAL_KEYS.has(wordKey(name));

export const FIRST_NAMES = [
  'João', 'Pedro', 'Lucas', 'Gabriel', 'Matheus', 'Rafael', 'Thiago', 'Vitor', 'Caio', 'Enzo',
  'Davi', 'Arthur', 'Bruno', 'Felipe', 'Igor', 'Kauã', 'Luan', 'Murilo', 'Nathan', 'Otávio',
  'Diego', 'Rodrigo', 'Leandro', 'Marcelo', 'André', 'Carlos', 'Daniel', 'Eduardo', 'Fábio', 'Gustavo',
  'Henrique', 'Júlio', 'Leonardo', 'Márcio', 'Paulo', 'Renato', 'Sérgio', 'Wellington', 'Wesley', 'Yuri',
  'Alisson', 'Breno', 'Cauã', 'Douglas', 'Elias', 'Fernando', 'Geovane', 'Hugo', 'Ian', 'Jonas',
  'Kevin', 'Lázaro', 'Maycon', 'Nicolas', 'Patrick', 'Ramon', 'Samuel', 'Tiago', 'Vinícius', 'Wagner',
];
export const LAST_NAMES = [
  'Silva', 'Santos', 'Oliveira', 'Souza', 'Lima', 'Ferreira', 'Costa', 'Rocha', 'Almeida', 'Gomes',
  'Ribeiro', 'Martins', 'Carvalho', 'Barbosa', 'Pereira', 'Nunes', 'Moura', 'Teixeira', 'Cardoso', 'Dias',
  'Araújo', 'Mendes', 'Freitas', 'Castro', 'Pinto', 'Vieira', 'Monteiro', 'Cavalcanti', 'Moreira', 'Batista',
  'Campos', 'Correia', 'Farias', 'Fonseca', 'Macedo', 'Machado', 'Medeiros', 'Nascimento', 'Pacheco', 'Ramos',
  'Rezende', 'Sales', 'Siqueira', 'Tavares', 'Viana', 'Xavier', 'Brito', 'Lopes', 'Matos', 'Queiroz',
];
// Apelidos à brasileira (usados em ~25% dos jogadores, no lugar do nome completo)
export const NICKNAMES = [
  'Juninho', 'Zé {L}', 'Biel', 'Dudu', 'Léo {L}', 'Tiquinho', 'Pedrinho', 'Netinho', 'Cacá', 'Guga',
  'Didi', 'Toninho', 'Fabinho', 'Marquinhos', 'Rafinha', 'Lucão', 'Bruninho', 'Teco', 'Vavá', 'Nenê',
];

export const SPONSOR_PREFIX = [
  'Banco', 'Construtora', 'Seguros', 'Telecom', 'Farmácias', 'Supermercados', 'Transportes',
  'Energia', 'Laticínios', 'Calçados', 'Motos', 'Imobiliária', 'Bebidas', 'Educacional', 'Tintas',
];
export const SPONSOR_NAME = [
  'Horizonte', 'Atlântico', 'Aurora', 'Ipê', 'Jequitibá', 'Pampa', 'Sertão', 'Litoral', 'Planalto',
  'Serra Azul', 'Vale Verde', 'Rio Claro', 'Sol Nascente', 'Bandeirante', 'Carnaúba', 'Mandacaru',
  'Araucária', 'Cajueiro', 'Pitanga', 'Guará',
];
export const KIT_BRANDS = ['Kaiman Sports', 'Trivela', 'Garra Esportes', 'Pique', 'Gol de Placa', 'Matuto'];
