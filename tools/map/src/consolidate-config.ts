/**
 * Réglages de la fusion des provinces (consolidate.ts), étape distincte du pipeline de carte :
 * après le regroupement et la découpe des unités admin-1 (provinces.ts), des provinces voisines
 * d'une même nation sont fusionnées pour réduire leur nombre (demande d'Amine : « divise par deux le
 * nombre de provinces »).
 *
 * Cible par nation, sur ses provinces fusionnables (celles qui ont une frontière terrestre avec une
 * autre province fusionnable du même domaine) :
 *   n ≤ keepUpTo (nombre total de provinces de la nation) → inchangée ;
 *   sinon cible = min(m, max(1, keepUpTo − (n − m), round(m × ratio))), m = provinces fusionnables
 *   (la nation garde au moins keepUpTo provinces, provinces figées comprises).
 * Les îles et territoires isolés (aucune frontière terrestre commune) et la province capitale ne
 * sont jamais fusionnés.
 */
export const CONSOLIDATE = {
  /** false : carte sans fusion (identique au pipeline d'avant la fusion). */
  enabled: true,
  /** Part conservée des provinces fusionnables d'une nation (0,5 = divisées par deux). */
  ratio: 0.42,
  /** Nations de 1 à keepUpTo provinces inchangées ; jamais moins de keepUpTo par fusion. */
  keepUpTo: 4,
  /**
   * La province capitale n'est jamais fusionnée : elle reste identique (nom, contour, ville,
   * bâtiments), seules ses voisines se regroupent.
   */
  keepCapitals: true,
  /**
   * Poids de la taille (part de superficie + part de population rapportée à la part typique d'une
   * province finale) à côté du nombre de provinces d'origine déjà réunies.
   */
  sizeWeight: 1,
  /** Coût ajouté pour fusionner deux provinces de régions différentes (Natural Earth ou REGION_HINTS). */
  regionPenalty: 1.5,
  /** Bonus pour réunir deux parties d'une même unité découpée (« Adrar Nord » + « Adrar Ouest »). */
  sameUnitBonus: 0.8,
  /** Poids de la compacité (part de la frontière commune dans le contour de la plus petite). */
  compactWeight: 1.2,
  /**
   * Poids de l'excentricité de la ville principale (point de capture et nœud routier) : distance au
   * membre le plus éloigné / rayon de la province fusionnée, au-delà de 1.
   */
  eccentricityWeight: 1,
};

/**
 * Régions de rattachement des nations dont Natural Earth ne fournit pas de région admin-1
 * (clé : nom de province ou d'unité découpée avant fusion). `name: true` : une province fusionnée
 * qui couvre exactement une région (et elle seule) en prend le nom.
 */
export const REGION_HINTS: Record<string, { name: boolean; regions: Record<string, string[]> }> = {
  // Algérie : grands ensembles inspirés des six régions militaires (Blida, Oran, Béchar, Ouargla,
  // Constantine, Tamanrasset) ; les wilayas voisines d'un même ensemble se regroupent d'abord.
  dza: {
    name: false,
    regions: {
      Centre: ['Alger', 'Blida', 'Médéa', 'Tizi Ouzou', 'Chlef', 'Djelfa', "M'Sila"],
      Ouest: ['Oran', 'Tlemcen', 'Sidi Bel Abbès', 'Mostaganem', 'Tiaret'],
      Est: [
        'Constantine',
        'Annaba',
        'Skikda',
        'Souk Ahras',
        'Sétif',
        'Batna',
        'Oum El Bouaghi',
        'Tébessa',
        'Béjaïa',
        'Biskra',
      ],
      'Sud-Ouest': ['Béchar', 'Tindouf', 'Adrar', 'Naâma', 'El Bayadh'],
      'Sud-Est': ['Ouargla', 'Ghardaïa', 'El Oued', 'Laghouat', 'Illizi'],
      'Grand Sud': ['Tamanrasset'],
    },
  },
  // Royaume-Uni : nations constitutives (Natural Earth ne donne que des sous-régions anglaises et
  // écossaises) ; jamais de province à cheval sur l'Angleterre et le pays de Galles ou l'Écosse.
  gbr: {
    name: false,
    regions: {
      Angleterre: [
        'Oxfordshire',
        'Sud-Est de l’Angleterre',
        'Nord-Est de l’Angleterre',
        'Nord-Ouest de l’Angleterre',
        'Sud-Ouest de l’Angleterre',
        'Devon',
        'Bournemouth',
        'Westminster',
        'Southend-on-Sea',
        'Midlands de l’Est',
        'Midlands de l’Ouest',
        'Sheffield',
        'Leeds',
      ],
      Écosse: ['Sud-Ouest de l’Écosse', 'Édimbourg', 'Highlands et îles'],
      'Pays de Galles': ['Cardiff'],
      'Irlande du Nord': ['Belfast'],
    },
  },
  // Maroc : régions de 2015 (Natural Earth décrit encore les 16 régions de 1997).
  mar: {
    name: true,
    regions: {
      'Tanger-Tétouan-Al Hoceïma': ['Tanger-Tétouan'],
      Oriental: ['Oriental'],
      'Fès-Meknès': ['Fès-Boulemane', 'Taza-Al Hoceïma-Taounate', 'Meknès-Tafilalet'],
      'Rabat-Salé-Kénitra': ['Rabat-Salé-Zemmour-Zaër', 'Gharb-Chrarda-Beni Hssen'],
      'Béni Mellal-Khénifra': ['Tadla-Azilal'],
      'Casablanca-Settat': ['Grand Casablanca', 'Chaouia-Ouardigha', 'Région Doukkala Abda'],
      'Marrakech-Safi': ['Marrakech-Tensift-Al Haouz'],
      'Souss-Massa': ['Souss-Massa-Drâa'],
      'Guelmim-Oued Noun': ['Guelmim-Es Semara'],
      'Laâyoune-Sakia El Hamra': ['Laâyoune-Boujdour-Sakia el Hamra'],
      'Dakhla-Oued Ed-Dahab': ['Oued Ed-Dahab'],
    },
  },
};
