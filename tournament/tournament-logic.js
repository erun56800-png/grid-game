// ============================================================
//  LOGIQUE PURE DU TOURNOI
//  Aucune dépendance au DOM ni à Firebase : uniquement des fonctions qui
//  prennent des données en entrée et renvoient un résultat. Ça permet de
//  les tester directement (voir tournament-logic.test.js) et de les
//  réutiliser aussi bien côté navigateur hôte que dans un futur script
//  Node si besoin.
// ============================================================

// ------------------------------------------------------------
//  Répartition en poules (taille cible ~4, aussi équilibrées que
//  possible). Retourne un tableau de poules, chaque poule étant un
//  tableau d'ids d'équipes.
// ------------------------------------------------------------
function assignPools(teamIds, targetSize, shuffleFn) {
  const shuffle = shuffleFn || defaultShuffle;
  const size = targetSize || 4;
  const n = teamIds.length;
  if (n === 0) return [];

  const poolCount = Math.max(1, Math.round(n / size));
  const base = Math.floor(n / poolCount);
  let remainder = n % poolCount;

  const shuffled = shuffle([...teamIds]);
  const pools = [];
  let idx = 0;
  for (let p = 0; p < poolCount; p++) {
    let poolSize = base;
    if (remainder > 0) { poolSize++; remainder--; }
    pools.push(shuffled.slice(idx, idx + poolSize));
    idx += poolSize;
  }
  return pools;
}

function defaultShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------
//  Calendrier round-robin (méthode du cercle) pour le mode Duels.
//  Retourne un tableau de "manches" (rounds) ; chaque manche est un
//  tableau de paires [equipeA, equipeB] pouvant être jouées en même
//  temps (aucune équipe n'apparaît deux fois dans la même manche).
//  Si le nombre d'équipes est impair, une équipe "bye" (repos) est
//  ajoutée en interne et n'apparaît dans aucune paire.
// ------------------------------------------------------------
function roundRobinRounds(teamIds) {
  const teams = [...teamIds];
  if (teams.length < 2) return [];
  if (teams.length % 2 !== 0) teams.push(null); // repos

  const n = teams.length;
  const rounds = [];
  const rotating = [...teams];

  for (let r = 0; r < n - 1; r++) {
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = rotating[i];
      const b = rotating[n - 1 - i];
      if (a !== null && b !== null) pairs.push([a, b]);
    }
    rounds.push(pairs);
    // Fait tourner tout le monde sauf le premier élément (fixe).
    rotating.splice(1, 0, rotating.pop());
  }
  return rounds;
}

// ------------------------------------------------------------
//  Classement d'une poule — mode Poule partagée.
//  roundScores : tableau (une entrée par manche jouée) d'objets
//  { teamId: score } donnant le score final de chaque équipe dans
//  cette manche.
//  Retourne un tableau trié (meilleur en premier) de
//  { teamId, totalScore, avgScore, gamesPlayed }.
// ------------------------------------------------------------
function computeSharedPoolStandings(teamIds, roundScores) {
  const totals = {};
  teamIds.forEach(id => { totals[id] = 0; });

  const gamesPlayed = roundScores.length;
  roundScores.forEach(scores => {
    teamIds.forEach(id => { totals[id] += scores[id] || 0; });
  });

  return teamIds
    .map(id => ({
      teamId: id,
      totalScore: totals[id],
      avgScore: gamesPlayed > 0 ? totals[id] / gamesPlayed : 0,
      gamesPlayed
    }))
    .sort((a, b) => b.totalScore - a.totalScore);
}

// ------------------------------------------------------------
//  Classement d'une poule — mode Duels.
//  matchResults : tableau de { teamA, teamB, winnerId, scoreA, scoreB }
//  Retourne un tableau trié (victoires, puis score total en cas
//  d'égalité) de { teamId, wins, totalScore, avgScore, gamesPlayed }.
// ------------------------------------------------------------
function computeDuelsPoolStandings(teamIds, matchResults) {
  const stats = {};
  teamIds.forEach(id => { stats[id] = { wins: 0, totalScore: 0, gamesPlayed: 0 }; });

  matchResults.forEach(m => {
    if (stats[m.teamA]) {
      stats[m.teamA].totalScore += m.scoreA || 0;
      stats[m.teamA].gamesPlayed += 1;
      if (m.winnerId === m.teamA) stats[m.teamA].wins += 1;
    }
    if (stats[m.teamB]) {
      stats[m.teamB].totalScore += m.scoreB || 0;
      stats[m.teamB].gamesPlayed += 1;
      if (m.winnerId === m.teamB) stats[m.teamB].wins += 1;
    }
  });

  return teamIds
    .map(id => ({
      teamId: id,
      wins: stats[id].wins,
      totalScore: stats[id].totalScore,
      avgScore: stats[id].gamesPlayed > 0 ? stats[id].totalScore / stats[id].gamesPlayed : 0,
      gamesPlayed: stats[id].gamesPlayed
    }))
    .sort((a, b) => (b.wins - a.wins) || (b.totalScore - a.totalScore));
}

// ------------------------------------------------------------
//  Sélectionne les 4 qualifié·e·s pour les demi-finales à partir des
//  classements de poule, avec repêchage automatique si le nombre de
//  poules ne donne pas exactement 4 premiers.
//
//  poolStandingsList : tableau (un par poule) de classements triés
//  (résultat de computeSharedPoolStandings / computeDuelsPoolStandings).
//
//  Retourne { qualifiers: [teamId x4, du mieux classé au moins bon],
//             qualifiersPerPool, wildcardIds: [...] }
// ------------------------------------------------------------
function selectQualifiers(poolStandingsList, totalQualifiers) {
  const target = totalQualifiers || 4;
  const poolCount = poolStandingsList.length;
  if (poolCount === 0) return { qualifiers: [], qualifiersPerPool: 0, wildcardIds: [] };

  const qualifiersPerPool = Math.floor(target / poolCount);
  const autoQualified = [];
  const remaining = [];

  poolStandingsList.forEach(standings => {
    standings.forEach((entry, idx) => {
      if (idx < qualifiersPerPool) autoQualified.push(entry);
      else remaining.push(entry);
    });
  });

  const wildcardsNeeded = Math.max(0, target - autoQualified.length);
  const sortedRemaining = [...remaining].sort((a, b) => b.avgScore - a.avgScore);
  const wildcards = sortedRemaining.slice(0, wildcardsNeeded);

  // Classement global des qualifié·e·s (pour le seeding des demies) :
  // meilleure moyenne d'étoiles par partie d'abord.
  const allQualified = [...autoQualified, ...wildcards]
    .sort((a, b) => b.avgScore - a.avgScore);

  return {
    qualifiers: allQualified.map(e => e.teamId),
    qualifiersPerPool,
    wildcardIds: wildcards.map(e => e.teamId)
  };
}

// ------------------------------------------------------------
//  Répartit les 4 qualifié·e·s (classé·e·s du meilleur au moins bon)
//  en 2 demi-finales façon "1 contre 4, 2 contre 3", pour éviter que
//  les deux meilleur·e·s ne s'affrontent avant la finale.
// ------------------------------------------------------------
function seedSemifinals(rankedQualifiers) {
  if (rankedQualifiers.length !== 4) {
    throw new Error('seedSemifinals attend exactement 4 équipes qualifiées');
  }
  const [seed1, seed2, seed3, seed4] = rankedQualifiers;
  return [
    { teamA: seed1, teamB: seed4 },
    { teamA: seed2, teamB: seed3 }
  ];
}

// Rendu accessible à la fois en environnement Node (tests) et navigateur
// (chargé via <script> classique, sans système de modules).
const TournamentLogic = {
  assignPools,
  roundRobinRounds,
  computeSharedPoolStandings,
  computeDuelsPoolStandings,
  selectQualifiers,
  seedSemifinals
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = TournamentLogic;
}
if (typeof window !== 'undefined') {
  window.TournamentLogic = TournamentLogic;
}
