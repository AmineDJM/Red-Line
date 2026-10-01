/**
 * Article défini français de chaque nation (genre et nombre réels) : « le » Maroc, « la » France,
 * « l' » Algérie, « les » États-Unis ; chaîne vide pour les noms employés sans article (Cuba,
 * Israël, Singapour, Malte, Madagascar…). Sert aux contractions « du / au / des / aux » et à
 * l'élision (voir `frDe`, `frA`, `frLe` dans @redline/shared). Toute nation produite par le
 * pipeline doit figurer ici (vérifié par le test et par la construction).
 */
import type { FrArticle } from '@redline/shared';

export const NATION_ARTICLE: Record<string, FrArticle> = {
  afg: "l'", // l'Afghanistan
  ago: "l'", // l'Angola
  alb: "l'", // l'Albanie
  and: "l'", // l'Andorre
  are: 'les', // les Émirats arabes unis
  arg: "l'", // l'Argentine
  arm: "l'", // l'Arménie
  atg: '', // Antigua-et-Barbuda
  aus: "l'", // l'Australie
  aut: "l'", // l'Autriche
  aze: "l'", // l'Azerbaïdjan
  bdi: 'le', // le Burundi
  bel: 'la', // la Belgique
  ben: 'le', // le Bénin
  bfa: 'le', // le Burkina Faso
  bgd: 'le', // le Bangladesh
  bgr: 'la', // la Bulgarie
  bhr: '', // Bahreïn
  bhs: 'les', // les Bahamas
  bih: 'la', // la Bosnie-Herzégovine
  blr: 'la', // la Biélorussie
  blz: 'le', // le Belize
  bol: 'la', // la Bolivie
  bra: 'le', // le Brésil
  brb: 'la', // la Barbade
  brn: 'le', // le Brunei
  btn: 'le', // le Bhoutan
  bwa: 'le', // le Botswana
  caf: 'la', // la Centrafrique
  can: 'le', // le Canada
  che: 'la', // la Suisse
  chl: 'le', // le Chili
  chn: 'la', // la Chine
  civ: 'la', // la Côte d'Ivoire
  cmr: 'le', // le Cameroun
  cod: 'la', // la RD Congo
  cog: 'le', // le Congo
  col: 'la', // la Colombie
  com: 'les', // les Comores
  cpv: 'le', // le Cap-Vert
  cri: 'le', // le Costa Rica
  cub: '', // Cuba
  cyn: '', // Chypre du Nord
  cyp: '', // Chypre
  cze: 'la', // la Tchéquie
  deu: "l'", // l'Allemagne
  dji: '', // Djibouti
  dma: 'la', // la Dominique
  dnk: 'le', // le Danemark
  dom: 'la', // la République dominicaine
  dza: "l'", // l'Algérie
  ecu: "l'", // l'Équateur
  egy: "l'", // l'Égypte
  eri: "l'", // l'Érythrée
  esh: 'le', // le Sahara occidental
  esp: "l'", // l'Espagne
  est: "l'", // l'Estonie
  eth: "l'", // l'Éthiopie
  fin: 'la', // la Finlande
  fji: 'les', // les Fidji
  fra: 'la', // la France
  fsm: 'la', // la Micronésie
  gab: 'le', // le Gabon
  gaza: 'la', // la Bande de Gaza
  gbr: 'le', // le Royaume-Uni
  geo: 'la', // la Géorgie
  gha: 'le', // le Ghana
  gin: 'la', // la Guinée
  gmb: 'la', // la Gambie
  gnb: 'la', // la Guinée-Bissau
  gnq: 'la', // la Guinée équatoriale
  grc: 'la', // la Grèce
  grd: 'la', // la Grenade
  gtm: 'le', // le Guatemala
  guy: 'le', // le Guyana
  hnd: 'le', // le Honduras (h aspiré)
  hrv: 'la', // la Croatie
  hti: '', // Haïti (h muet : d'Haïti)
  hun: 'la', // la Hongrie (h aspiré)
  idn: "l'", // l'Indonésie
  ind: "l'", // l'Inde
  irl: "l'", // l'Irlande
  irn: "l'", // l'Iran
  irq: "l'", // l'Irak
  isl: "l'", // l'Islande
  isr: '', // Israël
  ita: "l'", // l'Italie
  jam: 'la', // la Jamaïque
  jor: 'la', // la Jordanie
  jpn: 'le', // le Japon
  kaz: 'le', // le Kazakhstan
  ken: 'le', // le Kenya
  kgz: 'le', // le Kirghizistan
  khm: 'le', // le Cambodge
  kir: '', // Kiribati
  kna: '', // Saint-Christophe-et-Niévès
  kor: 'la', // la Corée du Sud
  kwt: 'le', // le Koweït
  lao: 'le', // le Laos
  lbn: 'le', // le Liban
  lbr: 'le', // le Liberia
  lby: 'la', // la Libye
  lca: '', // Sainte-Lucie
  lie: 'le', // le Liechtenstein
  lka: 'le', // le Sri Lanka
  lso: 'le', // le Lesotho
  ltu: 'la', // la Lituanie
  lux: 'le', // le Luxembourg
  lva: 'la', // la Lettonie
  mar: 'le', // le Maroc
  mco: '', // Monaco
  mda: 'la', // la Moldavie
  mdg: '', // Madagascar
  mdv: 'les', // les Maldives
  mex: 'le', // le Mexique
  mhl: 'les', // les Îles Marshall
  mkd: 'la', // la Macédoine du Nord
  mli: 'le', // le Mali
  mlt: '', // Malte
  mmr: 'la', // la Birmanie
  mne: 'le', // le Monténégro
  mng: 'la', // la Mongolie
  moz: 'le', // le Mozambique
  mrt: 'la', // la Mauritanie
  mus: '', // Maurice
  mwi: 'le', // le Malawi
  mys: 'la', // la Malaisie
  nam: 'la', // la Namibie
  ner: 'le', // le Niger
  nga: 'le', // le Nigeria
  nic: 'le', // le Nicaragua
  nld: 'les', // les Pays-Bas
  nor: 'la', // la Norvège
  npl: 'le', // le Népal
  nru: '', // Nauru
  nzl: 'la', // la Nouvelle-Zélande
  omn: '', // Oman
  pak: 'le', // le Pakistan
  pan: 'le', // le Panama
  per: 'le', // le Pérou
  phl: 'les', // les Philippines
  plw: 'les', // les Palaos
  png: 'la', // la Papouasie-Nouvelle-Guinée
  pol: 'la', // la Pologne
  prk: 'la', // la Corée du Nord
  prt: 'le', // le Portugal
  pry: 'le', // le Paraguay
  pse: "l'", // l'Autorité palestinienne
  qat: 'le', // le Qatar
  rou: 'la', // la Roumanie
  rus: 'la', // la Russie
  rwa: 'le', // le Rwanda
  sau: "l'", // l'Arabie saoudite
  sdn: 'le', // le Soudan
  sen: 'le', // le Sénégal
  sgp: '', // Singapour
  slb: 'les', // les Îles Salomon
  sle: 'la', // la Sierra Leone
  slv: 'le', // le Salvador
  smr: '', // Saint-Marin
  sol: 'le', // le Somaliland
  som: 'la', // la Somalie
  srb: 'la', // la Serbie
  ssd: 'le', // le Soudan du Sud
  stp: '', // Sao Tomé-et-Principe
  sur: 'le', // le Suriname
  svk: 'la', // la Slovaquie
  svn: 'la', // la Slovénie
  swe: 'la', // la Suède
  swz: "l'", // l'Eswatini
  syc: 'les', // les Seychelles
  syr: 'la', // la Syrie
  tcd: 'le', // le Tchad
  tgo: 'le', // le Togo
  tha: 'la', // la Thaïlande
  tjk: 'le', // le Tadjikistan
  tkm: 'le', // le Turkménistan
  tls: 'le', // le Timor oriental
  ton: 'les', // les Tonga
  tto: '', // Trinité-et-Tobago
  tun: 'la', // la Tunisie
  tur: 'la', // la Turquie
  tuv: '', // Tuvalu
  twn: '', // Taïwan
  tza: 'la', // la Tanzanie
  uga: "l'", // l'Ouganda
  ukr: "l'", // l'Ukraine
  ury: "l'", // l'Uruguay
  usa: 'les', // les États-Unis
  uzb: "l'", // l'Ouzbékistan
  vat: 'le', // le Vatican
  vct: '', // Saint-Vincent-et-les-Grenadines
  ven: 'le', // le Venezuela
  vnm: 'le', // le Viêt Nam
  vut: 'le', // le Vanuatu
  wsm: 'les', // les Samoa
  xkx: 'le', // le Kosovo
  yem: 'le', // le Yémen
  zaf: "l'", // l'Afrique du Sud
  zmb: 'la', // la Zambie
  zwe: 'le', // le Zimbabwe
};
