// ============================================================
//  MODE TOURNOI — Chasseurs d'Étoiles
//
//  Ce fichier est INDÉPENDANT du jeu principal (game.js n'est jamais
//  chargé ici) : les parties de tournoi sont de simples salles
//  "rooms/{code}" identiques à celles du jeu normal, créées ici avec
//  une copie minimale de la logique d'initialisation. Les équipes
//  rejoignent leur match via un lien classique vers ../index.html —
//  le jeu principal n'a donc besoin d'aucune modification pour
//  fonctionner en mode tournoi.
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyBeXzev-66h0PDkAB4jfI0zQD_f68iPhWU",
  authDomain: "grid-game-e511e.firebaseapp.com",
  databaseURL: "https://grid-game-e511e-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "grid-game-e511e",
  storageBucket: "grid-game-e511e.firebasestorage.app",
  messagingSenderId: "777360639613",
  appId: "1:777360639613:web:4108144b6ec0571e059314"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const T_GRID_SIZE = 10;
const T_DIRECTIONS = ['N', 'E', 'S', 'W'];
const T_KNOCKOUT_WIN_SCORE_DEFAULT = 20;

// ── État local ──
let tournamentRef   = null;
let tournamentCode  = '';
let myTeamId        = null;
let myTeamName      = '';
let amSpectator      = false;
let tState           = null;   // copie locale de l'état Firebase
let myHostToken      = null;
let hostTokenParam   = null;
let hostAdvanceInterval = null;
let tLiveRooms       = {};  // roomCode -> dernier état lu de rooms/{roomCode} (panneau admin)
let tLiveMatchesInfo  = []; // dernière liste de matchs en cours (voir collectActiveMatches)

window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const codeParam = params.get('tournoi');
  const nameParam  = params.get('name');
  const hostParam  = params.get('host');
  if (codeParam) document.getElementById('t-tournament-code').value = codeParam.toUpperCase();
  if (nameParam)  document.getElementById('t-team-name').value = nameParam;
  if (hostParam)  hostTokenParam = hostParam;
  if (codeParam && (nameParam || hostParam)) proceedFromTLogin();
});

// ============================================================
//  IDENTIFIANTS (même schéma que playerIdFor/slugifyName du jeu
//  principal, pour qu'une équipe rejoignant sa salle de match via
//  ?name=... retrouve exactement la même fiche joueur déjà créée ici).
// ============================================================
function slugifyTeamName(name) {
  return name.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'equipe';
}
function teamIdFor(name) {
  return 'player_' + slugifyTeamName(name);
}
function generateTHostToken() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'thost-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ============================================================
//  ÉCRAN DE CONNEXION
// ============================================================
async function proceedFromTLogin() {
  myTeamName     = document.getElementById('t-team-name').value.trim();
  tournamentCode = document.getElementById('t-tournament-code').value.trim().toUpperCase();
  amSpectator    = document.getElementById('t-spectator-checkbox').checked;
  const errEl = document.getElementById('t-login-error');
  errEl.textContent = '';

  if (!tournamentCode) { errEl.textContent = 'Entrez un code de tournoi.'; return; }
  if (!amSpectator && !myTeamName) { errEl.textContent = "Entrez le nom de l'équipe."; return; }

  const btn = document.getElementById('t-btn-join');
  if (btn) btn.disabled = true;

  try {
    tournamentRef = db.ref('tournaments/' + tournamentCode);
    const snap = await tournamentRef.once('value');

    if (snap.exists()) {
      const state = snap.val();

      if (hostTokenParam && state.hostToken === hostTokenParam) {
        myHostToken = hostTokenParam;
      }

      if (!amSpectator) {
        myTeamId = teamIdFor(myTeamName);
        const alreadyRegistered = state.teams && state.teams[myTeamId];
        if (!alreadyRegistered) {
          if (state.status !== 'registration') {
            errEl.textContent = "Le tournoi a déjà commencé : impossible de s'inscrire maintenant.";
            return;
          }
          await tournamentRef.child('teams/' + myTeamId).set({ name: myTeamName, checkedInAt: Date.now() });
        }
      }
    } else {
      // Un participant OU un simple organisateur (case "Ne participe pas" —
      // ex. le poste VPI) peut créer le tournoi ; il en devient l'hôte dans
      // les deux cas. Seul un participant obtient en plus une fiche équipe.
      myHostToken = generateTHostToken();
      if (!amSpectator) myTeamId = teamIdFor(myTeamName);
      await tournamentRef.set({
        hostToken:  myHostToken,
        createdAt:  Date.now(),
        status:     'registration',
        format:     'shared',
        poolRounds: 3,
        poolWinScore: 8,
        finalWinScore: T_KNOCKOUT_WIN_SCORE_DEFAULT,
        teams:      amSpectator ? {} : { [myTeamId]: { name: myTeamName, checkedInAt: Date.now() } },
        pools:      {},
        knockout:   {}
      });
    }

    enterTournamentScreen();
  } catch (e) {
    console.error('Erreur proceedFromTLogin :', e);
    errEl.textContent = (e && e.code === 'PERMISSION_DENIED')
      ? "⛔ Accès à la base de données refusé. Il manque probablement une règle Firebase pour le nœud \"tournaments\" (voir la documentation)."
      : "Erreur de connexion : " + (e && e.message ? e.message : e);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function enterTournamentScreen() {
  document.getElementById('screen-t-login').classList.remove('active');
  tournamentRef.on('value', onTStateUpdate, (err) => {
    console.error('Erreur de suivi du tournoi :', err);
    alert((err && err.code === 'PERMISSION_DENIED')
      ? "⛔ Connexion au tournoi perdue : accès à la base de données refusé (règle Firebase manquante pour \"tournaments\")."
      : "Connexion au tournoi perdue : " + (err && err.message ? err.message : err));
  });

  clearInterval(hostAdvanceInterval);
  hostAdvanceInterval = setInterval(() => {
    if (!isTHost() || !tState) return;
    if (tState.status === 'playing') hostAdvanceTournamentIfNeeded();
    refreshLiveMatchData();
  }, 5000);
}

function isTHost() {
  if (!tState) return false;
  if (myHostToken && tState.hostToken && myHostToken === tState.hostToken) return true;
  return false;
}

// ============================================================
//  LIENS
// ============================================================
function getTInviteLink() {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('tournoi', tournamentCode);
  return url.toString();
}
function getTHostLink() {
  const token = myHostToken || (tState && tState.hostToken) || '';
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('tournoi', tournamentCode);
  url.searchParams.set('host', token);
  return url.toString();
}
async function copyTInviteLink() {
  try {
    await navigator.clipboard.writeText(getTInviteLink());
    const fb = document.getElementById('t-lobby-link-feedback');
    if (fb) { fb.textContent = '✅ Lien copié !'; setTimeout(() => fb.textContent = '', 2500); }
  } catch (e) { window.prompt('Copiez ce lien :', getTInviteLink()); }
}

// Lien de reconnexion d'une équipe à SA salle de match (à communiquer si
// son terminal plante ou perd la connexion en cours de tournoi).
function getTeamMatchLink(roomCode, teamNameStr) {
  const url = new URL('../index.html', location.href);
  url.searchParams.set('room', roomCode);
  url.searchParams.set('name', teamNameStr);
  return url.toString();
}
// Lien "hôte" vers une salle de match précise : donne à l'administrateur
// du tournoi les contrôles hôte habituels du jeu (passer au joueur
// suivant, passage automatique...) dans cette partie précisément.
function getMatchSuperviseLink(roomCode) {
  const url = new URL('../index.html', location.href);
  url.searchParams.set('room', roomCode);
  url.searchParams.set('host', (tState && tState.hostToken) || myHostToken || '');
  return url.toString();
}
async function copyPlainLink(link, feedbackBtn) {
  try {
    await navigator.clipboard.writeText(link);
    if (feedbackBtn) {
      const original = feedbackBtn.textContent;
      feedbackBtn.textContent = '✅ Copié !';
      setTimeout(() => { feedbackBtn.textContent = original; }, 2000);
    }
  } catch (e) { window.prompt('Copiez ce lien :', link); }
}

async function pushTLog(msg) {
  await tournamentRef.child('log').push({ msg, ts: Date.now() });
}

// ============================================================
//  MISE À JOUR DE L'ÉTAT (listener Firebase)
// ============================================================
function onTStateUpdate(snap) {
  if (!snap.exists()) return;
  tState = snap.val();
  if (!tState.teams)    tState.teams    = {};
  if (!tState.pools)    tState.pools    = {};
  if (!tState.knockout) tState.knockout = {};

  if (tState.status === 'registration') {
    document.getElementById('screen-t-dashboard').classList.remove('active');
    document.getElementById('screen-t-lobby').classList.add('active');
    renderTLobby();
    return;
  }

  document.getElementById('screen-t-lobby').classList.remove('active');
  document.getElementById('screen-t-dashboard').classList.add('active');
  renderTDashboard();

  if (isTHost()) {
    hostAdvanceTournamentIfNeeded();
    refreshLiveMatchData();
  }
}

// ============================================================
//  SALLE D'INSCRIPTION
// ============================================================
function renderTLobby() {
  document.getElementById('t-lobby-code').textContent = tournamentCode;
  const linkInput = document.getElementById('t-lobby-invite-link');
  if (linkInput) linkInput.value = getTInviteLink();

  const teams = tState.teams || {};
  const list = document.getElementById('t-lobby-team-list');
  list.innerHTML = Object.values(teams).map(t => `<li>${escapeTHtml(t.name)}</li>`).join('');
  document.getElementById('t-lobby-team-count').textContent = `${Object.keys(teams).length} équipe(s) inscrite(s)`;

  const launchPanel = document.getElementById('t-host-launch-panel');
  const waitMsg = document.getElementById('t-lobby-wait-msg');
  if (isTHost()) {
    launchPanel.style.display = 'block';
    waitMsg.style.display = 'none';
    renderTLaunchEstimates();
  } else {
    launchPanel.style.display = 'none';
    waitMsg.style.display = 'block';
  }
}

function renderTLaunchEstimates() {
  const el = document.getElementById('t-launch-estimate');
  if (!el) return;
  const format = document.querySelector('input[name="t-format"]:checked').value;
  document.getElementById('t-shared-rounds-row').style.display = (format === 'shared') ? 'block' : 'none';

  const poolRounds = parseInt(document.getElementById('t-pool-rounds').value) || 3;
  const n = Object.keys((tState && tState.teams) || {}).length;

  if (n < 2) {
    el.innerHTML = '<p class="hint-text">En attente d\'au moins 2 équipes inscrites pour estimer la durée.</p>';
    return;
  }

  const poolCount = Math.max(1, Math.round(n / 4));
  const largestPool = Math.ceil(n / poolCount);
  const poolStageRounds = (format === 'shared')
    ? poolRounds
    : (largestPool % 2 === 0 ? largestPool - 1 : largestPool);
  const gamesPerTeamPool = (format === 'shared') ? poolRounds : (largestPool - 1);
  const totalRounds = poolStageRounds + 2; // + demies, + finale/petite finale

  const minLow  = Math.round(poolStageRounds * 4 + 2 * 10);
  const minHigh = Math.round(poolStageRounds * 8 + 2 * 20);

  el.innerHTML = `
    <p><strong>${n}</strong> équipe(s) → <strong>${poolCount}</strong> poule(s) (${format === 'shared' ? 'plateau partagé' : 'duels'})</p>
    <p>≈ <strong>${gamesPerTeamPool}</strong> partie(s) de poule par équipe, <strong>${gamesPerTeamPool + 2}</strong> pour les 4 qualifié·e·s</p>
    <p>≈ <strong>${totalRounds}</strong> manches au total — <strong>${minLow}-${minHigh} min</strong> (estimation large)</p>
  `;
}

// ============================================================
//  LANCEMENT DU TOURNOI
// ============================================================
async function launchTournament() {
  if (!isTHost() || !tState) return;
  const format       = document.querySelector('input[name="t-format"]:checked').value;
  const poolRounds    = Math.max(1, parseInt(document.getElementById('t-pool-rounds').value) || 3);
  const poolWinScore = Math.max(1, parseInt(document.getElementById('t-pool-win-score').value) || 8);

  const teamIds = Object.keys(tState.teams || {});
  if (teamIds.length < 2) { alert('Il faut au moins 2 équipes inscrites pour lancer le tournoi.'); return; }

  const pools = TournamentLogic.assignPools(teamIds, 4);
  const poolsData = {};
  pools.forEach((poolTeamIds, idx) => {
    poolsData[idx] = { teamIds: poolTeamIds, status: 'playing' };
    if (format === 'shared') {
      poolsData[idx].rounds = {};
    } else {
      poolsData[idx].matches = {};
      let m = 0;
      TournamentLogic.roundRobinRounds(poolTeamIds).forEach(round => {
        round.forEach(([a, b]) => {
          poolsData[idx].matches['m' + m] = { teamA: a, teamB: b, status: 'pending' };
          m++;
        });
      });
    }
  });

  const btn = document.getElementById('t-btn-launch');
  if (btn) btn.disabled = true;
  try {
    await tournamentRef.update({
      status: 'playing',
      format, poolRounds, poolWinScore,
      pools: poolsData
    });
    await pushTLog(`🏆 Tournoi lancé — ${format === 'shared' ? 'Poule partagée' : 'Duels'}, ${teamIds.length} équipe(s), ${pools.length} poule(s).`);
  } catch (e) {
    console.error('Erreur launchTournament :', e);
    if (btn) btn.disabled = false;
    alert((e && e.code === 'PERMISSION_DENIED')
      ? "⛔ Accès à la base de données refusé. Il manque probablement une règle Firebase pour le nœud \"tournaments\" (voir la documentation)."
      : "Erreur lors du lancement du tournoi : " + (e && e.message ? e.message : e));
  }
}

// ============================================================
//  CRÉATION D'UNE SALLE DE MATCH (copie minimale et indépendante de
//  la logique d'initialisation du jeu principal — voir l'en-tête)
// ============================================================
function generateTMatchObjects(count, avoidKeys) {
  const objects = {};
  const avoid = avoidKeys || {};
  let placed = 0, attempts = 0;
  while (placed < count && attempts < 500) {
    attempts++;
    const x = Math.floor(Math.random() * T_GRID_SIZE);
    const y = Math.floor(Math.random() * T_GRID_SIZE);
    const key = `${x}_${y}`;
    if (!objects[key] && !avoid[key]) { objects[key] = { x, y, type: 'star' }; placed++; }
  }
  return objects;
}

function createMatchRoomState(teamEntries, winScore) {
  const objects = generateTMatchObjects(15, {});
  const players = {};
  teamEntries.forEach((t, i) => {
    players[t.id] = {
      name: t.name, colorIndex: i,
      x: Math.floor(Math.random() * T_GRID_SIZE), y: Math.floor(Math.random() * T_GRID_SIZE),
      direction: T_DIRECTIONS[Math.floor(Math.random() * 4)],
      score: 0, movesLeft: 0, movesUsed: 0, movementMode: 'relative',
      totalActiveMs: 0, turnScoreGained: 0, autoSkip: false, online: true
    };
  });
  const order = teamEntries.map(t => t.id).sort(() => Math.random() - 0.5);
  const first = order[0];
  players[first].movesLeft = Math.floor(Math.random() * 10) + 1;

  return {
    status: 'playing', turn: 1, currentPlayer: first, playerOrder: order,
    players, objects, traps: {}, log: {},
    settings: {
      // hostToken reprend celui du tournoi : le lien "Superviser" de
      // l'administrateur donne ainsi les contrôles hôte habituels (passer
      // au joueur suivant, passage automatique...) dans CHAQUE salle de
      // match, sans avoir à re-générer un jeton par match.
      movementMode: 'relative', modeLocked: false, hostId: null, hostToken: tState.hostToken || null,
      expectedPlayers: teamEntries.length, gameModePolicy: 'free', ghostAllowed: true,
      minMoves: 1, maxMoves: 10, winScore: winScore, initObjects: 15,
      turnTimeLimit: 0, trapsEnabled: false, trapCount: 0, preAssignMoves: true,
      rejoinWindowMs: 120000
    },
    gameNumber: 1, history: {}, rematchVotes: {},
    createdAt: Date.now(), turnStartedAt: Date.now()
  };
}

function teamName(id) {
  return (tState && tState.teams && tState.teams[id] && tState.teams[id].name) || id;
}
function mkEntries(ids) {
  return ids.map(id => ({ id, name: teamName(id) }));
}

// ============================================================
//  ORCHESTRATION AUTOMATIQUE (hôte uniquement)
// ============================================================
async function hostAdvanceTournamentIfNeeded() {
  if (!isTHost() || !tState || tState.status !== 'playing') return;

  const pools = tState.pools || {};
  const poolIds = Object.keys(pools);
  let anyPoolNotDone = false;

  for (const poolId of poolIds) {
    const pool = pools[poolId];
    if (pool.status === 'done') continue;
    anyPoolNotDone = true;
    if (tState.format === 'shared') {
      await advanceSharedPool(poolId, pool);
    } else {
      await advanceDuelsPool(poolId, pool);
    }
  }
  if (anyPoolNotDone) return;

  if (!tState.knockout || !tState.knockout.semi1) {
    await setupKnockoutStage();
    return;
  }
  await advanceKnockoutStage();
}

async function advanceSharedPool(poolId, pool) {
  const rounds = pool.rounds || {};
  const roundIds = Object.keys(rounds).map(Number);
  const totalRounds = tState.poolRounds || 3;

  if (roundIds.length > 0) {
    const lastId = String(Math.max(...roundIds));
    const last = rounds[lastId];
    if (last.status !== 'done') {
      const roomSnap = await db.ref('rooms/' + last.roomCode).once('value');
      const roomState = roomSnap.val();
      if (roomState && (roomState.status === 'finished' || roomState.status === 'ended')) {
        const scores = {};
        pool.teamIds.forEach(id => { scores[id] = (roomState.players && roomState.players[id] && roomState.players[id].score) || 0; });
        await tournamentRef.update({
          [`pools/${poolId}/rounds/${lastId}/status`]: 'done',
          [`pools/${poolId}/rounds/${lastId}/scores`]: scores
        });
      }
      return;
    }
  }

  if (roundIds.length < totalRounds) {
    const newRoundId = String(roundIds.length);
    const roomCode = `T-${tournamentCode}-P${poolId}-R${newRoundId}`;
    await db.ref('rooms/' + roomCode).set(createMatchRoomState(mkEntries(pool.teamIds), tState.poolWinScore));
    await tournamentRef.update({ [`pools/${poolId}/rounds/${newRoundId}`]: { roomCode, status: 'playing' } });
    return;
  }

  const roundScores = Object.values(rounds).map(r => r.scores || {});
  const standings = TournamentLogic.computeSharedPoolStandings(pool.teamIds, roundScores);
  await tournamentRef.update({ [`pools/${poolId}/standings`]: standings, [`pools/${poolId}/status`]: 'done' });
  await pushTLog(`✅ Poule ${Number(poolId) + 1} terminée.`);
}

async function advanceDuelsPool(poolId, pool) {
  const matches = pool.matches || {};
  const matchIds = Object.keys(matches);

  let allDone = true;
  for (const mid of matchIds) {
    const m = matches[mid];
    if (m.status === 'done') continue;
    allDone = false;
    if (m.status === 'playing') {
      const roomSnap = await db.ref('rooms/' + m.roomCode).once('value');
      const roomState = roomSnap.val();
      if (roomState && (roomState.status === 'finished' || roomState.status === 'ended')) {
        const scoreA = (roomState.players[m.teamA] || {}).score || 0;
        const scoreB = (roomState.players[m.teamB] || {}).score || 0;
        const winnerId = scoreA >= scoreB ? m.teamA : m.teamB;
        await tournamentRef.update({
          [`pools/${poolId}/matches/${mid}/status`]: 'done',
          [`pools/${poolId}/matches/${mid}/scoreA`]: scoreA,
          [`pools/${poolId}/matches/${mid}/scoreB`]: scoreB,
          [`pools/${poolId}/matches/${mid}/winnerId`]: winnerId
        });
      }
    }
  }

  if (allDone) {
    const results = Object.values(matches);
    const standings = TournamentLogic.computeDuelsPoolStandings(pool.teamIds, results);
    await tournamentRef.update({ [`pools/${poolId}/standings`]: standings, [`pools/${poolId}/status`]: 'done' });
    await pushTLog(`✅ Poule ${Number(poolId) + 1} terminée.`);
    return;
  }

  // Lance tout match "pending" dont les deux équipes sont libres (ni en
  // train de jouer un autre match de cette poule, ni déjà "done" ailleurs
  // en simultané) — permet à plusieurs matchs de la poule de tourner en
  // parallèle sans jamais faire jouer une équipe deux fois à la fois.
  const busyTeams = new Set();
  matchIds.forEach(mid => {
    if (matches[mid].status === 'playing') {
      busyTeams.add(matches[mid].teamA);
      busyTeams.add(matches[mid].teamB);
    }
  });
  for (const mid of matchIds) {
    const m = matches[mid];
    if (m.status !== 'pending') continue;
    if (busyTeams.has(m.teamA) || busyTeams.has(m.teamB)) continue;
    const roomCode = `T-${tournamentCode}-P${poolId}-${mid}`;
    await db.ref('rooms/' + roomCode).set(createMatchRoomState(mkEntries([m.teamA, m.teamB]), tState.poolWinScore));
    await tournamentRef.update({
      [`pools/${poolId}/matches/${mid}/roomCode`]: roomCode,
      [`pools/${poolId}/matches/${mid}/status`]: 'playing'
    });
    busyTeams.add(m.teamA);
    busyTeams.add(m.teamB);
  }
}

async function setupKnockoutStage() {
  const poolStandingsList = Object.values(tState.pools || {}).map(p => p.standings || []);
  const { qualifiers } = TournamentLogic.selectQualifiers(poolStandingsList, 4);

  if (qualifiers.length < 4) {
    await tournamentRef.update({ status: 'finished', finalStandingsNote: "Pas assez d'équipes pour une phase finale à 4." });
    await pushTLog('⚠️ Tournoi terminé : pas assez d\'équipes pour une phase finale.');
    return;
  }

  const [semi1, semi2] = TournamentLogic.seedSemifinals(qualifiers);
  const semi1Room = `T-${tournamentCode}-SEMI1`;
  const semi2Room = `T-${tournamentCode}-SEMI2`;
  const finalWinScore = tState.finalWinScore || T_KNOCKOUT_WIN_SCORE_DEFAULT;

  await db.ref('rooms/' + semi1Room).set(createMatchRoomState(mkEntries([semi1.teamA, semi1.teamB]), finalWinScore));
  await db.ref('rooms/' + semi2Room).set(createMatchRoomState(mkEntries([semi2.teamA, semi2.teamB]), finalWinScore));

  await tournamentRef.update({
    qualifiers,
    'knockout/semi1': { teamA: semi1.teamA, teamB: semi1.teamB, roomCode: semi1Room, status: 'playing' },
    'knockout/semi2': { teamA: semi2.teamA, teamB: semi2.teamB, roomCode: semi2Room, status: 'playing' }
  });
  await pushTLog('🥇 Phase finale lancée : demi-finales en cours. Les autres équipes peuvent regarder !');
}

async function advanceKnockoutStage() {
  const ko = tState.knockout || {};
  const finalWinScore = tState.finalWinScore || T_KNOCKOUT_WIN_SCORE_DEFAULT;

  for (const key of ['semi1', 'semi2']) {
    const m = ko[key];
    if (m && m.status === 'playing') {
      const roomSnap = await db.ref('rooms/' + m.roomCode).once('value');
      const roomState = roomSnap.val();
      if (roomState && (roomState.status === 'finished' || roomState.status === 'ended')) {
        const scoreA = (roomState.players[m.teamA] || {}).score || 0;
        const scoreB = (roomState.players[m.teamB] || {}).score || 0;
        const winnerId = scoreA >= scoreB ? m.teamA : m.teamB;
        const loserId  = winnerId === m.teamA ? m.teamB : m.teamA;
        await tournamentRef.update({
          [`knockout/${key}/status`]: 'done',
          [`knockout/${key}/winnerId`]: winnerId,
          [`knockout/${key}/loserId`]: loserId
        });
      }
      return;
    }
  }

  if (!ko.semi1 || !ko.semi2 || ko.semi1.status !== 'done' || ko.semi2.status !== 'done') return;

  if (!ko.final) {
    const finalRoom  = `T-${tournamentCode}-FINAL`;
    const bronzeRoom = `T-${tournamentCode}-BRONZE`;
    await db.ref('rooms/' + finalRoom).set(createMatchRoomState(mkEntries([ko.semi1.winnerId, ko.semi2.winnerId]), finalWinScore));
    await db.ref('rooms/' + bronzeRoom).set(createMatchRoomState(mkEntries([ko.semi1.loserId, ko.semi2.loserId]), finalWinScore));
    await tournamentRef.update({
      'knockout/final':  { teamA: ko.semi1.winnerId, teamB: ko.semi2.winnerId, roomCode: finalRoom,  status: 'playing' },
      'knockout/bronze': { teamA: ko.semi1.loserId,  teamB: ko.semi2.loserId,  roomCode: bronzeRoom, status: 'playing' }
    });
    await pushTLog('🏆 Finale et petite finale lancées !');
    return;
  }

  for (const key of ['final', 'bronze']) {
    const m = ko[key];
    if (m.status === 'playing') {
      const roomSnap = await db.ref('rooms/' + m.roomCode).once('value');
      const roomState = roomSnap.val();
      if (roomState && (roomState.status === 'finished' || roomState.status === 'ended')) {
        const scoreA = (roomState.players[m.teamA] || {}).score || 0;
        const scoreB = (roomState.players[m.teamB] || {}).score || 0;
        const winnerId = scoreA >= scoreB ? m.teamA : m.teamB;
        await tournamentRef.update({ [`knockout/${key}/status`]: 'done', [`knockout/${key}/winnerId`]: winnerId });
      }
      return;
    }
  }

  if (ko.final.status !== 'done' || ko.bronze.status !== 'done') return;

  const rank1 = ko.final.winnerId;
  const rank2 = ko.final.teamA === rank1 ? ko.final.teamB : ko.final.teamA;
  const rank3 = ko.bronze.winnerId;
  const rank4 = ko.bronze.teamA === rank3 ? ko.bronze.teamB : ko.bronze.teamA;

  await tournamentRef.update({ status: 'finished', finalStandings: { rank1, rank2, rank3, rank4 } });
  await pushTLog('🎉 Tournoi terminé — classement final disponible !');
}

// ============================================================
//  TROUVER LE MATCH EN COURS D'UNE ÉQUIPE
// ============================================================
function findMyCurrentMatch() {
  if (!tState || !myTeamId) return null;

  const pools = tState.pools || {};
  for (const poolId of Object.keys(pools)) {
    const pool = pools[poolId];
    if (!pool.teamIds.includes(myTeamId)) continue;
    if (tState.format === 'shared') {
      const rounds = pool.rounds || {};
      for (const rid of Object.keys(rounds)) {
        if (rounds[rid].status === 'playing') return rounds[rid].roomCode;
      }
    } else {
      const matches = pool.matches || {};
      for (const mid of Object.keys(matches)) {
        const m = matches[mid];
        if (m.status === 'playing' && (m.teamA === myTeamId || m.teamB === myTeamId)) return m.roomCode;
      }
    }
  }

  const ko = tState.knockout || {};
  for (const key of ['semi1', 'semi2', 'final', 'bronze']) {
    const m = ko[key];
    if (m && m.status === 'playing' && (m.teamA === myTeamId || m.teamB === myTeamId)) return m.roomCode;
  }
  return null;
}

function openMyCurrentMatch() {
  const roomCode = findMyCurrentMatch();
  if (!roomCode) return;
  const url = new URL('../index.html', location.href);
  url.searchParams.set('room', roomCode);
  url.searchParams.set('name', myTeamName);
  window.open(url.toString(), '_blank');
}

// ============================================================
//  PANNEAU ADMINISTRATEUR (hôte uniquement) — vue d'ensemble en direct
//  de tous les matchs en cours, avec liens de secours par équipe et
//  contrôles rapides (passage automatique / superviser une partie).
// ============================================================
function collectActiveMatches() {
  if (!tState) return [];
  const list = [];
  const pools = tState.pools || {};
  Object.keys(pools).sort((a, b) => Number(a) - Number(b)).forEach(poolId => {
    const pool = pools[poolId];
    if (tState.format === 'shared') {
      const rounds = pool.rounds || {};
      Object.keys(rounds).sort((a, b) => Number(a) - Number(b)).forEach(rid => {
        const r = rounds[rid];
        if (r.status === 'playing') {
          list.push({ label: `Poule ${Number(poolId) + 1} — Manche ${Number(rid) + 1}`, roomCode: r.roomCode, teamIds: pool.teamIds });
        }
      });
    } else {
      const matches = pool.matches || {};
      Object.keys(matches).forEach(mid => {
        const m = matches[mid];
        if (m.status === 'playing') {
          list.push({ label: `Poule ${Number(poolId) + 1} — ${teamName(m.teamA)} vs ${teamName(m.teamB)}`, roomCode: m.roomCode, teamIds: [m.teamA, m.teamB] });
        }
      });
    }
  });

  const ko = tState.knockout || {};
  const koLabels = { semi1: '🥉 Demi-finale 1', semi2: '🥉 Demi-finale 2', final: '🏆 Finale', bronze: '🥈 Petite finale (3e/4e)' };
  Object.keys(koLabels).forEach(key => {
    const m = ko[key];
    if (m && m.status === 'playing') list.push({ label: koLabels[key], roomCode: m.roomCode, teamIds: [m.teamA, m.teamB] });
  });

  return list;
}

async function refreshLiveMatchData() {
  if (!isTHost() || !tState) return;
  const matches = collectActiveMatches();
  const entries = await Promise.all(matches.map(async m => {
    const snap = await db.ref('rooms/' + m.roomCode).once('value');
    return [m.roomCode, snap.val()];
  }));
  tLiveRooms = Object.fromEntries(entries);
  tLiveMatchesInfo = matches;
  renderTAdminPanel();
}

// Bascule le passage automatique d'une équipe DIRECTEMENT depuis le
// panneau admin (même effet que la case à cocher dans le panneau hôte du
// jeu normal — voir hostSetAutoSkip dans game.js — mais sans avoir besoin
// d'ouvrir la partie). L'action de "passer au joueur suivant" ponctuelle,
// elle, reste dans le lien "Superviser" : elle dépend de règles de jeu
// plus complexes (déplacements, régénération des objets...) qu'il vaut
// mieux ne garder qu'à un seul endroit (game.js) pour ne jamais diverger.
async function tAdminToggleAutoSkip(roomCode, playerId, checked) {
  if (!isTHost()) return;
  await db.ref('rooms/' + roomCode).update({ [`players/${playerId}/autoSkip`]: !!checked });
  if (tLiveRooms[roomCode] && tLiveRooms[roomCode].players && tLiveRooms[roomCode].players[playerId]) {
    tLiveRooms[roomCode].players[playerId].autoSkip = !!checked;
  }
}

function renderTAdminPanel() {
  const section = document.getElementById('t-admin-panel');
  if (!section) return;
  if (!isTHost() || tLiveMatchesInfo.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const linkRegistry = [];    // idx -> lien à copier/ouvrir
  const skipRegistry  = [];   // idx -> { roomCode, playerId }

  const html = tLiveMatchesInfo.map(m => {
    const room = tLiveRooms[m.roomCode];
    if (!room) return '';
    const players = room.players || {};
    const rows = m.teamIds.map(id => {
      const p = players[id];
      if (!p) return '';
      const isTurn = room.currentPlayer === id;
      const linkIdx = linkRegistry.push(getTeamMatchLink(m.roomCode, p.name)) - 1;
      const skipIdx = skipRegistry.push({ roomCode: m.roomCode, playerId: id }) - 1;
      return `<li class="t-admin-player-row${isTurn ? ' t-admin-turn' : ''}">
        <span class="t-admin-player-name">${isTurn ? '▶ ' : ''}${escapeTHtml(p.name)}</span>
        <span class="t-admin-player-score">${p.score || 0} ⭐</span>
        <label class="t-admin-autoskip"><input type="checkbox" data-skip-idx="${skipIdx}" ${p.autoSkip ? 'checked' : ''}> passer auto</label>
        <button class="small-btn" data-link-idx="${linkIdx}" data-link-action="copy" title="Copier le lien de reconnexion de cette équipe">🔗 Lien</button>
      </li>`;
    }).join('');
    const superviseIdx = linkRegistry.push(getMatchSuperviseLink(m.roomCode)) - 1;
    return `<div class="t-admin-match-card">
      <h4>${escapeTHtml(m.label)}</h4>
      <ul class="t-admin-player-list">${rows}</ul>
      <button class="small-btn t-admin-supervise-btn" data-link-idx="${superviseIdx}" data-link-action="open" title="Ouvrir cette partie avec les contrôles hôte (passer au joueur suivant, etc.)">🔧 Superviser cette partie</button>
    </div>`;
  }).join('');

  section.innerHTML = `
    <h3>🛠️ Vue d'ensemble en direct (administrateur)</h3>
    <p class="hint-text">🔗 copie le lien de reconnexion d'une équipe (à communiquer si son terminal se déconnecte). 🔧 ouvre la partie avec les contrôles hôte pour passer un joueur ponctuellement.</p>
    <div id="t-admin-matches">${html}</div>
  `;

  // Reconnecte les boutons/cases à leurs données réelles via des propriétés
  // JS (jamais interpolées dans du HTML) : mêmes précautions que pour
  // l'historique des salles, les noms d'équipe étant du texte libre.
  const container = document.getElementById('t-admin-matches');
  container.querySelectorAll('[data-link-idx]').forEach(el => {
    el.__link = linkRegistry[Number(el.getAttribute('data-link-idx'))];
  });
  container.querySelectorAll('[data-skip-idx]').forEach(el => {
    el.__skip = skipRegistry[Number(el.getAttribute('data-skip-idx'))];
  });

  if (!container.__wired) {
    container.__wired = true;
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-link-action]');
      if (!btn || !btn.__link) return;
      if (btn.getAttribute('data-link-action') === 'open') window.open(btn.__link, '_blank');
      else copyPlainLink(btn.__link, btn);
    });
    container.addEventListener('change', (e) => {
      const cb = e.target.closest('[data-skip-idx]');
      if (!cb || !cb.__skip) return;
      tAdminToggleAutoSkip(cb.__skip.roomCode, cb.__skip.playerId, cb.checked);
    });
  }
}

// ============================================================
//  TABLEAU DE BORD
// ============================================================
function escapeTHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function renderTDashboard() {
  document.getElementById('t-dash-code').textContent = tournamentCode;
  renderTMyMatchPanel();
  renderTAdminPanel();
  renderTPools();
  renderTKnockout();
  renderTFinalStandings();
}

function renderTMyMatchPanel() {
  const panel = document.getElementById('t-my-match-panel');
  if (amSpectator || !myTeamId) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';

  document.getElementById('t-my-match-title').textContent = `Équipe : ${teamName(myTeamId)}`;
  const statusEl = document.getElementById('t-my-match-status');
  const btn = document.getElementById('t-btn-join-match');

  const roomCode = findMyCurrentMatch();
  if (roomCode) {
    statusEl.textContent = "🎮 C'est votre match !";
    btn.style.display = 'inline-block';
  } else if (tState.status === 'finished') {
    statusEl.textContent = '🏁 Tournoi terminé — voir le classement final ci-dessous.';
    btn.style.display = 'none';
  } else {
    statusEl.textContent = '⏳ En attente de votre prochain match — vous pouvez suivre les autres parties ci-dessous.';
    btn.style.display = 'none';
  }
}

function renderTPools() {
  const el = document.getElementById('t-pools-view');
  const pools = tState.pools || {};
  const poolIds = Object.keys(pools).sort((a, b) => Number(a) - Number(b));

  el.innerHTML = poolIds.map(poolId => {
    const pool = pools[poolId];
    const teamsTxt = pool.teamIds.map(teamName).map(escapeTHtml).join(', ');
    const statusTxt = pool.status === 'done' ? '✅ Terminée' : '▶ En cours';
    let standingsHtml = '';
    if (pool.standings && pool.standings.length) {
      standingsHtml = '<ol class="t-standings">' + pool.standings.map(s =>
        `<li>${escapeTHtml(teamName(s.teamId))} — ${s.totalScore != null ? s.totalScore : ''}${s.wins != null ? ` (${s.wins}V)` : ''}</li>`
      ).join('') + '</ol>';
    }
    return `<div class="t-pool-card">
      <h4>Poule ${Number(poolId) + 1} — ${statusTxt}</h4>
      <p class="hint-text">${teamsTxt}</p>
      ${standingsHtml}
    </div>`;
  }).join('');
}

function renderTKnockout() {
  const wrap = document.getElementById('t-knockout-view');
  const ko = tState.knockout || {};
  if (!ko.semi1) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const rows = [
    ['🥉 Demi-finale 1', ko.semi1],
    ['🥉 Demi-finale 2', ko.semi2],
    ['🏆 Finale', ko.final],
    ['🥈 Petite finale (3e/4e place)', ko.bronze]
  ];

  document.getElementById('t-knockout-list').innerHTML = rows.map(([label, m]) => {
    if (!m) return `<div class="t-knockout-row"><span>${label}</span><span class="hint-text">à venir</span></div>`;
    const statusTxt = m.status === 'done'
      ? `✅ ${escapeTHtml(teamName(m.winnerId))} gagne`
      : '▶ En cours';
    return `<div class="t-knockout-row">
      <span>${label}</span>
      <span>${escapeTHtml(teamName(m.teamA))} vs ${escapeTHtml(teamName(m.teamB))} — ${statusTxt}</span>
    </div>`;
  }).join('');
}

function renderTFinalStandings() {
  const wrap = document.getElementById('t-final-standings');
  if (tState.status !== 'finished' || !tState.finalStandings) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  const fs = tState.finalStandings;
  const list = document.getElementById('t-final-standings-list');
  list.innerHTML = [
    ['🥇', fs.rank1], ['🥈', fs.rank2], ['🥉', fs.rank3], ['4e', fs.rank4]
  ].map(([medal, id]) => `<li>${medal} ${escapeTHtml(teamName(id))}</li>`).join('');
}
