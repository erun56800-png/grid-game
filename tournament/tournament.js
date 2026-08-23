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
let myMatchWindowRef     = null; // fenêtre ouverte par openMyCurrentMatch()
let myMatchWindowRoomCode = null; // code de salle qu'elle affiche actuellement

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
    if (!tState) return;
    if (isTHost() && tState.status === 'playing') hostAdvanceTournamentIfNeeded();
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
  // game.js met TOUJOURS le code de salle en majuscules avant de le
  // chercher dans Firebase (sensible à la casse) — on s'aligne ici pour
  // que le lien fonctionne quelle que soit la casse du roomCode stocké.
  url.searchParams.set('room', String(roomCode).toUpperCase());
  url.searchParams.set('name', teamNameStr);
  return url.toString();
}
// Lien "hôte" vers une salle de match précise : donne à l'administrateur
// du tournoi les contrôles hôte habituels du jeu (passer au joueur
// suivant, passage automatique...) dans cette partie précisément.
function getMatchSuperviseLink(roomCode) {
  const url = new URL('../index.html', location.href);
  url.searchParams.set('room', String(roomCode).toUpperCase());
  url.searchParams.set('host', (tState && tState.hostToken) || myHostToken || '');
  return url.toString();
}
// Lien "spectateur" vers une salle de match précise : permet à n'importe
// quelle équipe (éliminée, qualifiée mais inactive, ou simplement en
// attente) de suivre en direct la finale/petite finale sur son propre
// terminal, sans les contrôles hôte.
function getMatchSpectateLink(roomCode) {
  const url = new URL('../index.html', location.href);
  url.searchParams.set('room', String(roomCode).toUpperCase());
  url.searchParams.set('spectator', '1');
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
  refreshLiveMatchData();

  if (isTHost()) hostAdvanceTournamentIfNeeded();
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
// Lit le formulaire "Format du tournoi" et le traduit dans le vocabulaire
// des réglages du jeu normal (settings.gameModePolicy / .ghostAllowed /
// .movementMode / .modeLocked), pour que chaque salle de match créée par
// createMatchRoomState() applique exactement ces réglages à toutes les
// équipes.
function readTMatchSettingsForm() {
  const movesPerTurn = Math.max(1, parseInt(document.getElementById('t-moves-per-turn').value) || 8);
  const trapsEnabled = document.getElementById('t-traps-enabled').checked;
  const trapCount    = Math.max(0, parseInt(document.getElementById('t-trap-count').value) || 0);

  const movementSel = document.getElementById('t-movement-mode').value; // 'relative' | 'absolute' | 'free'
  const modeLocked   = movementSel !== 'free';
  const movementMode = modeLocked ? movementSel : 'relative';

  const gameModeSel = document.getElementById('t-game-mode').value; // 'direct' | 'deferred' | 'deferred-ghost' | 'free'
  const gameModePolicy = gameModeSel === 'free' ? 'free' : (gameModeSel === 'direct' ? 'forceDirect' : 'forceDeferred');
  const ghostAllowed    = gameModeSel === 'deferred-ghost' || gameModeSel === 'free';

  const turnTimeEnabled = document.getElementById('t-turn-time-enabled').checked;
  const turnTimeLimit   = turnTimeEnabled ? Math.max(10, parseInt(document.getElementById('t-turn-time-limit').value) || 180) : 0;

  return { movesPerTurn, trapsEnabled, trapCount, modeLocked, movementMode, gameModePolicy, ghostAllowed, turnTimeLimit };
}

async function launchTournament() {
  if (!isTHost() || !tState) return;
  const format       = document.querySelector('input[name="t-format"]:checked').value;
  const poolRounds    = Math.max(1, parseInt(document.getElementById('t-pool-rounds').value) || 3);
  const poolWinScore = Math.max(1, parseInt(document.getElementById('t-pool-win-score').value) || 8);
  const matchSettings = readTMatchSettingsForm();

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
      format, poolRounds, poolWinScore, matchSettings,
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

// Valeurs par défaut si le tournoi a été créé avant l'ajout du
// paramétrage (matchSettings absent) ou si un champ n'a pas été soumis.
const T_MATCH_SETTINGS_DEFAULTS = {
  movesPerTurn: 8, trapsEnabled: true, trapCount: 10,
  modeLocked: true, movementMode: 'relative',
  gameModePolicy: 'forceDeferred', ghostAllowed: false,
  turnTimeLimit: 180
};

function createMatchRoomState(teamEntries, winScore) {
  const ms = Object.assign({}, T_MATCH_SETTINGS_DEFAULTS, (tState && tState.matchSettings) || {});

  const objects = generateTMatchObjects(15, {});
  const players = {};
  teamEntries.forEach((t, i) => {
    players[t.id] = {
      name: t.name, colorIndex: i,
      x: Math.floor(Math.random() * T_GRID_SIZE), y: Math.floor(Math.random() * T_GRID_SIZE),
      direction: T_DIRECTIONS[Math.floor(Math.random() * 4)],
      // Comme dans le jeu normal (voir joinExistingRoom/randomMovesFromSettings
      // dans game.js), CHAQUE joueur reçoit ses déplacements dès la création
      // de la salle — pas seulement celui qui commence. Sans ça, un joueur
      // qui n'est pas tiré au sort en premier arrive à son tour avec 0
      // déplacement et ne peut plus rien faire (le mécanisme de
      // "pré-attribution" ne donne des déplacements qu'au joueur qui VIENT
      // de terminer un tour, pour son tour SUIVANT — un joueur qui n'a
      // jamais encore joué n'en a donc jamais reçu).
      score: 0, movesLeft: ms.movesPerTurn, movesUsed: 0, movementMode: ms.movementMode,
      totalActiveMs: 0, turnScoreGained: 0, autoSkip: false, online: true
    };
  });
  const order = teamEntries.map(t => t.id).sort(() => Math.random() - 0.5);
  const first = order[0];

  return {
    status: 'playing', turn: 1, currentPlayer: first, playerOrder: order,
    players, objects, traps: {}, log: {},
    settings: {
      // hostToken reprend celui du tournoi : le lien "Superviser" de
      // l'administrateur donne ainsi les contrôles hôte habituels (passer
      // au joueur suivant, passage automatique...) dans CHAQUE salle de
      // match, sans avoir à re-générer un jeton par match.
      movementMode: ms.movementMode, modeLocked: ms.modeLocked, hostId: null, hostToken: tState.hostToken || null,
      expectedPlayers: teamEntries.length, gameModePolicy: ms.gameModePolicy, ghostAllowed: ms.ghostAllowed,
      minMoves: ms.movesPerTurn, maxMoves: ms.movesPerTurn, winScore: winScore, initObjects: 15,
      turnTimeLimit: ms.turnTimeLimit, trapsEnabled: ms.trapsEnabled, trapCount: ms.trapCount, preAssignMoves: true,
      // Plus court que le délai par défaut du jeu normal (2 min) : dans un
      // match de tournoi ce délai n'est de toute façon qu'un filet de
      // sécurité, closeMatchRoom() (voir plus bas) fait déjà repasser la
      // salle en attente dès que l'orchestrateur a récupéré le score final.
      rejoinWindowMs: 8000
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

// Fait sortir les équipes de l'écran "fin de partie" (rester/quitter) dès
// que l'orchestrateur a récupéré le score final d'un match — sans attendre
// le minuteur de 2 minutes du jeu normal, qui ne se déclenche de toute
// façon JAMAIS ici : aucune équipe d'un match de tournoi n'est "hôte" de
// sa propre salle (seul l'administrateur du tournoi l'est, via le jeton
// hôte), donc ce vote resterait bloqué indéfiniment sans cette étape.
// Chaque manche étant une salle à usage unique, le vote "rester/quitter"
// n'a de toute façon pas de sens ici — on fait simplement passer la salle
// en "salle d'attente" pour que l'écran de fin de partie se referme
// (l'équipe retrouve alors sa propre page Tournoi, où son prochain match
// apparaîtra dès que l'hôte l'aura créé).
async function closeMatchRoom(roomCode) {
  await db.ref('rooms/' + roomCode).update({ status: 'waiting', rejoinStatus: {}, rematchVotes: {} });
}

// ============================================================
//  ORCHESTRATION AUTOMATIQUE (hôte uniquement)
// ============================================================
// Verrou de ré-entrance : chaque écriture faite ici déclenche le listener
// .on('value', onTStateUpdate) qui rappelle lui-même cette fonction — sans
// ce verrou, un appel imbriqué pourrait s'exécuter AVANT que l'appel en
// cours n'ait fini d'écrire toutes ses étapes (ex : manche marquée "done"
// mais manche suivante pas encore créée), et lirait alors un état
// intermédiaire incohérent (poule marquée "terminée" avec une seule manche
// jouée sur deux, par exemple). Le verrou fait que seul l'appel déjà en
// cours agit ; les appels imbriqués ou concurrents (minuteur de 5s compris)
// se contentent de ne rien faire, l'état étant de toute façon repris au
// prochain appel une fois celui-ci terminé.
let tAdvanceInProgress = false;
async function hostAdvanceTournamentIfNeeded() {
  if (tAdvanceInProgress) return;
  if (!isTHost() || !tState || tState.status !== 'playing') return;
  tAdvanceInProgress = true;
  try {
    await hostAdvanceTournamentStep();
  } finally {
    tAdvanceInProgress = false;
  }
}

async function hostAdvanceTournamentStep() {
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

// Toutes les manches d'une même poule (mode "Poule partagée") se jouent
// dans LA MÊME salle, réutilisée d'une manche à l'autre : dès que
// l'orchestrateur capture le score d'une manche terminée, il relance
// directement la manche suivante dans cette salle (nouvel écrasement de
// son état par createMatchRoomState) au lieu d'ouvrir une nouvelle salle.
// Les équipes gardent donc le MÊME onglet ouvert d'une manche à l'autre —
// il se met à jour tout seul — et ne passent jamais par la salle d'attente
// générique du jeu normal (où personne n'est hôte pour la relancer) tant
// qu'il reste des manches à jouer dans cette poule.
async function advanceSharedPool(poolId, pool) {
  const rounds = pool.rounds || {};
  const roundIds = Object.keys(rounds).map(Number);
  const totalRounds = tState.poolRounds || 3;
  const poolRoomCode = pool.roomCode || `T-${tournamentCode}-P${poolId}`;

  if (roundIds.length === 0) {
    await db.ref('rooms/' + poolRoomCode).set(createMatchRoomState(mkEntries(pool.teamIds), tState.poolWinScore));
    await tournamentRef.update({
      [`pools/${poolId}/roomCode`]: poolRoomCode,
      [`pools/${poolId}/rounds/0`]: { roomCode: poolRoomCode, status: 'playing' }
    });
    return;
  }

  const lastId = String(Math.max(...roundIds));
  const last = rounds[lastId];
  if (last.status !== 'done') {
    const roomSnap = await db.ref('rooms/' + poolRoomCode).once('value');
    const roomState = roomSnap.val();
    if (!roomState || (roomState.status !== 'finished' && roomState.status !== 'ended')) return; // manche toujours en cours

    const scores = {};
    pool.teamIds.forEach(id => { scores[id] = (roomState.players && roomState.players[id] && roomState.players[id].score) || 0; });

    if (roundIds.length < totalRounds) {
      // D'autres manches restent à jouer : capture le score ET relance tout
      // de suite la manche suivante, dans la même salle, en une seule étape
      // (jamais de passage par la salle d'attente entre deux manches).
      const newRoundId = String(roundIds.length);
      await db.ref('rooms/' + poolRoomCode).set(createMatchRoomState(mkEntries(pool.teamIds), tState.poolWinScore));
      await tournamentRef.update({
        [`pools/${poolId}/rounds/${lastId}/status`]: 'done',
        [`pools/${poolId}/rounds/${lastId}/scores`]: scores,
        [`pools/${poolId}/rounds/${newRoundId}`]: { roomCode: poolRoomCode, status: 'playing' }
      });
      return;
    }

    // Dernière manche de la poule : capture son score ET calcule directement
    // les classements finaux dans la même étape (plutôt que d'attendre un
    // appel supplémentaire de l'orchestrateur pour s'en apercevoir).
    const roundScores = Object.keys(rounds).map(rid => (rid === lastId ? scores : (rounds[rid].scores || {})));
    const standings = TournamentLogic.computeSharedPoolStandings(pool.teamIds, roundScores);
    await tournamentRef.update({
      [`pools/${poolId}/rounds/${lastId}/status`]: 'done',
      [`pools/${poolId}/rounds/${lastId}/scores`]: scores,
      [`pools/${poolId}/standings`]: standings,
      [`pools/${poolId}/status`]: 'done'
    });
    await closeMatchRoom(poolRoomCode);
    await pushTLog(`✅ Poule ${Number(poolId) + 1} terminée.`);
  }
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
        await closeMatchRoom(m.roomCode);
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
    // game.js met TOUJOURS en majuscules le code de salle saisi (à la main
    // ou via l'URL — voir roomParam.toUpperCase() dans son DOMContentLoaded)
    // avant de le chercher dans Firebase, qui est sensible à la casse. Le
    // code généré ici doit donc être en majuscules dès le départ (mid, lui,
    // reste en minuscules : ce n'est qu'une clé interne du tournoi, jamais
    // utilisée comme code de salle tel quel).
    const roomCode = `T-${tournamentCode}-P${poolId}-${mid}`.toUpperCase();
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

// Capture le résultat de chaque match "playing" du groupe fourni (les deux
// demies, ou la finale + petite finale) EN UNE SEULE ÉTAPE — plutôt que de
// s'arrêter au premier trouvé et compter sur un appel séparé pour le
// second (les deux matchs d'un même groupe sont indépendants, aucune
// raison d'attendre un passage supplémentaire de l'orchestrateur pour
// traiter le second alors que son score est peut-être déjà disponible).
// Renvoie true si tous les matchs du groupe sont "done" à l'issue de cet
// appel (y compris ceux capturés à l'instant).
async function advanceKnockoutGroup(keys, ko) {
  let allDone = true;
  for (const key of keys) {
    const m = ko[key];
    if (!m) { allDone = false; continue; }
    if (m.status === 'done') continue;
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
      await closeMatchRoom(m.roomCode);
      // Répercute sur l'objet local `ko` (passé par référence) : sans ça,
      // l'appelant continuerait à lire l'ancien statut "playing" et un
      // winnerId manquant pour ce match tant que tState n'a pas été
      // rafraîchi par le listener Firebase (ex : pour construire tout de
      // suite la finale à partir des vainqueurs des demies).
      m.status = 'done';
      m.winnerId = winnerId;
      m.loserId = loserId;
    } else {
      allDone = false;
    }
  }
  return allDone;
}

async function advanceKnockoutStage() {
  const ko = tState.knockout || {};

  if (!(await advanceKnockoutGroup(['semi1', 'semi2'], ko))) return;

  // Les deux demies sont terminées : on n'enchaîne PAS automatiquement sur
  // la finale et la petite finale — c'est désormais l'hôte qui les lance
  // explicitement (le temps de rassembler tout le monde autour du VPI,
  // par exemple), via hostLaunchFinals(). L'orchestrateur se contente
  // d'attendre ici tant que ce n'est pas fait.
  if (!ko.final) return;

  if (!(await advanceKnockoutGroup(['final', 'bronze'], ko))) return;

  const rank1 = ko.final.winnerId;
  const rank2 = ko.final.teamA === rank1 ? ko.final.teamB : ko.final.teamA;
  const rank3 = ko.bronze.winnerId;
  const rank4 = ko.bronze.teamA === rank3 ? ko.bronze.teamB : ko.bronze.teamA;

  await tournamentRef.update({ status: 'finished', finalStandings: { rank1, rank2, rank3, rank4 } });
  await pushTLog('🎉 Tournoi terminé — classement final disponible !');
}

// Déclenché par un clic de l'hôte (voir renderTKnockout) une fois les deux
// demi-finales terminées : lance explicitement la finale et la petite
// finale — jamais automatiquement, pour laisser l'hôte rassembler tout le
// monde (VPI, etc.) avant de démarrer.
async function hostLaunchFinals() {
  if (!isTHost() || !tState) return;
  const ko = tState.knockout || {};
  if (!ko.semi1 || !ko.semi2 || ko.semi1.status !== 'done' || ko.semi2.status !== 'done') return;
  if (ko.final) return; // déjà lancées

  const finalWinScore = tState.finalWinScore || T_KNOCKOUT_WIN_SCORE_DEFAULT;
  const finalRoom  = `T-${tournamentCode}-FINAL`;
  const bronzeRoom = `T-${tournamentCode}-BRONZE`;

  const btn = document.getElementById('t-btn-launch-finals');
  if (btn) btn.disabled = true;
  try {
    await db.ref('rooms/' + finalRoom).set(createMatchRoomState(mkEntries([ko.semi1.winnerId, ko.semi2.winnerId]), finalWinScore));
    await db.ref('rooms/' + bronzeRoom).set(createMatchRoomState(mkEntries([ko.semi1.loserId, ko.semi2.loserId]), finalWinScore));
    await tournamentRef.update({
      'knockout/final':  { teamA: ko.semi1.winnerId, teamB: ko.semi2.winnerId, roomCode: finalRoom,  status: 'playing' },
      'knockout/bronze': { teamA: ko.semi1.loserId,  teamB: ko.semi2.loserId,  roomCode: bronzeRoom, status: 'playing' }
    });
    await pushTLog("🏆 Finale et petite finale lancées par l'hôte !");
  } finally {
    if (btn) btn.disabled = false;
  }
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
  url.searchParams.set('room', String(roomCode).toUpperCase());
  url.searchParams.set('name', myTeamName);
  // On garde une référence à l'onglet ouvert (voir closeStaleMatchWindow) :
  // dès qu'il ne montrera plus le match en cours de l'équipe, on le
  // referme nous-mêmes plutôt que de le laisser affiché sur la salle
  // d'attente générique du jeu normal (fenêtre "intempestive" oubliée
  // ouverte à la fin de chaque match de poule).
  myMatchWindowRef = window.open(url.toString(), '_blank');
  myMatchWindowRoomCode = roomCode;
}

// Referme automatiquement l'onglet de match ouvert par openMyCurrentMatch()
// dès qu'il ne correspond plus au match en cours de l'équipe (partie
// terminée et aucune nouvelle manche à la même adresse — voir la
// réutilisation de salle en mode Poule partagée, qui NE déclenche PAS
// cette fermeture puisque le roomCode reste identique d'une manche à
// l'autre). Appelée à chaque mise à jour du tableau de bord.
function closeStaleMatchWindow() {
  if (!myMatchWindowRef) return;
  if (myMatchWindowRef.closed) { myMatchWindowRef = null; myMatchWindowRoomCode = null; return; }
  if (findMyCurrentMatch() === myMatchWindowRoomCode) return; // toujours le bon match (ou la même salle réutilisée)
  try { myMatchWindowRef.close(); } catch (e) { /* onglet déjà fermé ou hors de portée */ }
  myMatchWindowRef = null;
  myMatchWindowRoomCode = null;
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

// Écoute Firebase en temps réel (pas un simple sondage périodique) : dès
// qu'un score change dans une salle de match suivie, la mise à jour arrive
// immédiatement et re-dessine le panneau. La liste des salles suivies est
// resynchronisée à chaque changement d'état du tournoi (nouvelles manches
// créées, poule terminée...), avec un appel de sécurité toutes les 5s.
let tLiveRoomListeners = {};  // roomCode -> callback attaché (pour se désabonner proprement)
let tLiveTickInterval  = null;

// Écoute désormais active pour TOUT LE MONDE (pas seulement l'hôte) : les
// scores en direct alimentent à la fois le panneau administrateur (contrôles
// en plus, hôte uniquement), le classement provisoire des poules en cours,
// et le panneau "finales en direct" visible par toutes les équipes,
// y compris celles déjà éliminées ou qualifiées mais pas encore sur scène.
function refreshLiveMatchData() {
  if (!tState) { teardownLiveMatchListeners(); return; }

  const matches = collectActiveMatches();
  tLiveMatchesInfo = matches;
  const activeCodes = new Set(matches.map(m => m.roomCode));

  Object.keys(tLiveRoomListeners).forEach(code => {
    if (activeCodes.has(code)) return;
    db.ref('rooms/' + code).off('value', tLiveRoomListeners[code]);
    delete tLiveRoomListeners[code];
    delete tLiveRooms[code];
  });

  activeCodes.forEach(code => {
    if (tLiveRoomListeners[code]) return;
    const cb = (snap) => { tLiveRooms[code] = snap.val(); renderTLiveViews(); };
    tLiveRoomListeners[code] = cb;
    db.ref('rooms/' + code).on('value', cb);
  });

  // Re-dessine chaque seconde même sans nouvel événement Firebase, pour
  // que les temps affichés (temps de tour en cours, etc.) restent vivants.
  if (!tLiveTickInterval) {
    tLiveTickInterval = setInterval(() => {
      if (Object.keys(tLiveRoomListeners).length > 0) renderTLiveViews();
    }, 1000);
  }

  renderTLiveViews();
}

// Regroupe tout ce qui dépend des données live (tLiveRooms) : le panneau
// admin, le panneau "finales en direct" pour tout le monde, et les
// classements provisoires des poules en cours.
function renderTLiveViews() {
  renderTAdminPanel();
  renderTLiveFinalsPanel();
  if (tState && tState.status === 'playing') renderTPools();
}

function teardownLiveMatchListeners() {
  Object.keys(tLiveRoomListeners).forEach(code => db.ref('rooms/' + code).off('value', tLiveRoomListeners[code]));
  tLiveRoomListeners = {};
  tLiveRooms = {};
  tLiveMatchesInfo = [];
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor((ms || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
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
      const turnElapsedMs = isTurn ? Math.max(0, Date.now() - (room.turnStartedAt || Date.now())) : 0;
      const totalMs = (p.totalActiveMs || 0) + turnElapsedMs;
      const linkIdx = linkRegistry.push(getTeamMatchLink(m.roomCode, p.name)) - 1;
      const skipIdx = skipRegistry.push({ roomCode: m.roomCode, playerId: id }) - 1;
      return `<li class="t-admin-player-row${isTurn ? ' t-admin-turn' : ''}">
        <div class="t-admin-player-main">
          <span class="t-admin-player-name">${isTurn ? '▶ ' : ''}${escapeTHtml(p.name)}</span>
          <span class="t-admin-player-score">${p.score || 0} ⭐</span>
          <span class="t-admin-player-time" title="Temps total de jeu (tours cumulés)">⏱ ${formatDuration(totalMs)}</span>
          <span class="t-admin-player-time" title="Temps du tour en cours">${isTurn ? '🔄 ' + formatDuration(turnElapsedMs) : '—'}</span>
        </div>
        <div class="t-admin-player-controls">
          <label class="t-admin-autoskip"><input type="checkbox" data-skip-idx="${skipIdx}" ${p.autoSkip ? 'checked' : ''}> passer auto</label>
          <button class="small-btn" data-link-idx="${linkIdx}" data-link-action="copy" title="Copier le lien de reconnexion de cette équipe">🔗 Lien</button>
        </div>
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
//  FINALES EN DIRECT (visible de TOUTES les équipes, pas seulement
//  l'hôte) — scores en direct de la petite finale et de la finale une
//  fois lancées par l'hôte, avec un lien pour les suivre en spectateur
//  sur son propre terminal (utile aux équipes déjà éliminées comme aux
//  qualifiées qui ne jouent pas ce match-là).
// ============================================================
function renderTLiveFinalsPanel() {
  const section = document.getElementById('t-live-finals-panel');
  if (!section || !tState) return;

  const ko = tState.knockout || {};
  const entries = [['🏆 Finale', ko.final], ['🥈 Petite finale (3e/4e place)', ko.bronze]]
    .filter(([, m]) => !!m);

  if (entries.length === 0) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const linkRegistry = [];
  const html = entries.map(([label, m]) => {
    const room = tLiveRooms[m.roomCode];
    const teamsHtml = [m.teamA, m.teamB].map(id => {
      const p = room && room.players ? room.players[id] : null;
      const score = p ? (p.score || 0) : 0;
      const isTurn = room && room.currentPlayer === id;
      return `<span class="t-finals-team${isTurn ? ' t-finals-turn' : ''}">${isTurn ? '▶ ' : ''}${escapeTHtml(teamName(id))} — ${score} ⭐</span>`;
    }).join(' <span class="t-finals-vs">vs</span> ');
    const statusTxt = m.status === 'done' ? `✅ ${escapeTHtml(teamName(m.winnerId))} gagne` : '🔴 En direct';
    const linkIdx = linkRegistry.push(getMatchSpectateLink(m.roomCode)) - 1;
    return `<div class="t-finals-card">
      <h4>${escapeTHtml(label)}</h4>
      <p class="t-finals-teams">${teamsHtml}</p>
      <p class="t-finals-status">${statusTxt}</p>
      <button class="small-btn" data-link-idx="${linkIdx}">👁 Suivre en direct</button>
    </div>`;
  }).join('');

  section.innerHTML = `
    <h3>📡 Finales en direct</h3>
    <div id="t-live-finals-matches">${html}</div>
  `;

  const container = document.getElementById('t-live-finals-matches');
  container.querySelectorAll('[data-link-idx]').forEach(el => {
    el.__link = linkRegistry[Number(el.getAttribute('data-link-idx'))];
  });
  if (!container.__wired) {
    container.__wired = true;
    container.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-link-idx]');
      if (!btn || !btn.__link) return;
      window.open(btn.__link, '_blank');
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
  renderTLiveFinalsPanel();
  renderTPools();
  renderTKnockout();
  renderTFinalStandings();
}

// Message contextuel affiché à une équipe qui ne joue pas actuellement :
// où elle en est dans le tournoi, et — dès que c'est connu — contre qui
// elle affrontera son prochain match (petite finale ou finale).
function tMyStatusMessage() {
  if (tState.status === 'finished') return '🏁 Tournoi terminé — voir le classement final ci-dessous.';

  const myPool = Object.values(tState.pools || {}).find(p => p.teamIds.includes(myTeamId));
  const poolDone = myPool && myPool.status === 'done';
  if (myPool && !poolDone) {
    return '⏳ En attente de votre prochaine manche/match de poule — classement provisoire ci-dessous.';
  }

  const ko = tState.knockout || {};
  if (!ko.semi1) {
    return poolDone
      ? "✅ Votre poule est terminée — en attente de la fin des autres poules pour connaître les équipes qualifiées."
      : '⏳ En attente de la fin de votre poule.';
  }

  const qualifiers = tState.qualifiers || [];
  if (!qualifiers.includes(myTeamId)) {
    return "Vous n'êtes pas qualifié·e·s pour la phase finale — merci d'avoir participé ! Vous pouvez suivre la suite du tournoi ci-dessous.";
  }

  const mySemiKey = (ko.semi1.teamA === myTeamId || ko.semi1.teamB === myTeamId) ? 'semi1'
    : (ko.semi2.teamA === myTeamId || ko.semi2.teamB === myTeamId) ? 'semi2' : null;
  const mySemi = mySemiKey ? ko[mySemiKey] : null;
  if (!mySemi) return '⏳ Qualifié·e·s ! En attente du tirage des demi-finales.';
  if (mySemi.status !== 'done') return '🥉 Votre demi-finale va commencer !';

  const otherKey = mySemiKey === 'semi1' ? 'semi2' : 'semi1';
  const other = ko[otherKey];
  const won = mySemi.winnerId === myTeamId;
  const resultTxt = won
    ? `✅ Vous avez gagné votre demi-finale (${teamName(mySemi.teamA)} vs ${teamName(mySemi.teamB)}) !`
    : `Vous avez perdu votre demi-finale (${teamName(mySemi.teamA)} vs ${teamName(mySemi.teamB)}).`;
  const nextStage = won ? 'la Finale' : 'la Petite Finale';

  if (!ko.final) {
    if (other.status !== 'done') {
      return `${resultTxt} Préparez-vous à affronter le/la ${won ? 'vainqueur' : 'perdant·e'} de ${teamName(other.teamA)} vs ${teamName(other.teamB)} en ${nextStage} — en attente de la fin de l'autre demi-finale.`;
    }
    const opponentId = won ? other.winnerId : other.loserId;
    return `${resultTxt} Préparez-vous à affronter ${teamName(opponentId)} en ${nextStage} — en attente que l'hôte lance les matchs.`;
  }

  return '🏁 Votre parcours en phase finale est terminé — voir le classement final ci-dessous.';
}

function renderTMyMatchPanel() {
  closeStaleMatchWindow();
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
  } else {
    statusEl.textContent = tMyStatusMessage();
    btn.style.display = 'none';
  }
}

// Ligne "match" d'une poule (manche partagée ou duel), avec son statut —
// joué / en cours / à venir — dans le même esprit que les pages à
// compléter au fil d'une coupe du monde de football.
function tMatchRowHtml(label, status, resultTxt) {
  const icon = status === 'done' ? '✅' : (status === 'playing' ? '▶' : '⏳');
  const cls  = status === 'done' ? 't-match-done' : (status === 'playing' ? 't-match-playing' : 't-match-upcoming');
  return `<li class="t-match-row ${cls}">
    <span>${icon} ${escapeTHtml(label)}</span>
    <span class="t-match-result">${resultTxt ? escapeTHtml(resultTxt) : (status === 'playing' ? 'en cours' : 'à venir')}</span>
  </li>`;
}

// Classement provisoire d'une poule EN COURS, mélangeant les manches/matchs
// déjà "done" avec le score en direct de la manche/du match actuellement
// joué (tLiveRooms, alimenté par refreshLiveMatchData()) — réutilise
// directement les fonctions pures déjà testées de tournament-logic.js,
// juste nourries de données provisoires plutôt que du résultat final
// stocké sur le tournoi.
function computeLivePoolStandings(pool) {
  if (tState.format === 'shared') {
    const rounds = pool.rounds || {};
    const roundScores = Object.keys(rounds).sort((a, b) => Number(a) - Number(b)).map(rid => {
      const r = rounds[rid];
      if (r.status === 'done') return r.scores || {};
      const live = tLiveRooms[r.roomCode];
      if (!live || !live.players) return null;
      const s = {};
      pool.teamIds.forEach(id => { s[id] = (live.players[id] && live.players[id].score) || 0; });
      return s;
    }).filter(Boolean);
    if (roundScores.length === 0) return null;
    return TournamentLogic.computeSharedPoolStandings(pool.teamIds, roundScores);
  }

  // Mode Duels : le classement se fonde sur les victoires déjà actées —
  // un match en cours n'a pas encore de vainqueur, on ne l'inclut donc que
  // pour information (score en direct affiché à part), jamais dans le tri.
  const doneMatches = Object.values(pool.matches || {}).filter(m => m.status === 'done');
  if (doneMatches.length === 0) return null;
  return TournamentLogic.computeDuelsPoolStandings(pool.teamIds, doneMatches);
}

function renderTPools() {
  const el = document.getElementById('t-pools-view');
  const pools = tState.pools || {};
  const poolIds = Object.keys(pools).sort((a, b) => Number(a) - Number(b));

  el.innerHTML = poolIds.map(poolId => {
    const pool = pools[poolId];
    const teamsTxt = pool.teamIds.map(teamName).map(escapeTHtml).join(', ');
    const statusTxt = pool.status === 'done' ? '✅ Terminée' : '▶ En cours';

    let matchRows;
    if (tState.format === 'shared') {
      const totalRounds = tState.poolRounds || 3;
      const rounds = pool.rounds || {};
      matchRows = [];
      for (let i = 0; i < totalRounds; i++) {
        const r = rounds[i];
        const label = `Manche ${i + 1}`;
        if (!r) { matchRows.push(tMatchRowHtml(label, 'upcoming')); continue; }
        const resultTxt = (r.status === 'done' && r.scores)
          ? pool.teamIds.map(id => `${teamName(id)} ${r.scores[id] != null ? r.scores[id] : 0}`).join(' · ')
          : null;
        matchRows.push(tMatchRowHtml(label, r.status, resultTxt));
      }
    } else {
      const matches = pool.matches || {};
      matchRows = Object.keys(matches).map(mid => {
        const m = matches[mid];
        const label = `${teamName(m.teamA)} vs ${teamName(m.teamB)}`;
        const resultTxt = m.status === 'done' ? `${m.scoreA}-${m.scoreB} (${teamName(m.winnerId)} gagne)` : null;
        return tMatchRowHtml(label, m.status, resultTxt);
      });
    }

    const standings = pool.status === 'done' ? pool.standings : computeLivePoolStandings(pool);
    let standingsHtml = '';
    if (standings && standings.length) {
      const label = pool.status === 'done' ? '🏁 Classement final' : '🔴 Classement provisoire';
      standingsHtml = `<p class="t-standings-label">${label}</p><ol class="t-standings">` + standings.map(s =>
        `<li>${escapeTHtml(teamName(s.teamId))} — ${s.totalScore != null ? s.totalScore : ''}${s.wins != null ? ` (${s.wins}V)` : ''}</li>`
      ).join('') + '</ol>';
    }
    return `<div class="t-pool-card">
      <h4>Poule ${Number(poolId) + 1} — ${statusTxt}</h4>
      <p class="hint-text">${teamsTxt}</p>
      <ul class="t-match-list">${matchRows.join('')}</ul>
      ${standingsHtml}
    </div>`;
  }).join('');
}

// Vue "arborescence" de la phase finale (demies -> finale / petite finale),
// façon page à compléter de coupe du monde : une carte par match, avec son
// statut, reliée visuellement par une flèche vers l'étape suivante.
function tBracketCardHtml(label, m, extraClass) {
  const teamsTxt = m ? `${teamName(m.teamA)} vs ${teamName(m.teamB)}` : '?';
  const status = !m ? 'upcoming' : m.status;
  const icon = status === 'done' ? '✅' : (status === 'playing' ? '▶' : '⏳');
  const resultTxt = (m && m.status === 'done') ? `${escapeTHtml(teamName(m.winnerId))} gagne` : (status === 'playing' ? 'en cours' : 'à venir');
  const cls = status === 'done' ? 't-bracket-done' : (status === 'playing' ? 't-bracket-playing' : 't-bracket-upcoming');
  return `<div class="t-bracket-match ${cls}${extraClass ? ' ' + extraClass : ''}">
    <div class="t-bracket-match-label">${escapeTHtml(label)}</div>
    <div class="t-bracket-match-teams">${escapeTHtml(teamsTxt)}</div>
    <div class="t-bracket-match-status">${icon} ${escapeTHtml(resultTxt)}</div>
  </div>`;
}

function renderTKnockout() {
  const wrap = document.getElementById('t-knockout-view');
  const ko = tState.knockout || {};
  if (!ko.semi1) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';

  const semisReady = ko.semi1.status === 'done' && ko.semi2.status === 'done';
  const launchHtml = (isTHost() && semisReady && !ko.final)
    ? `<div class="t-bracket-launch">
         <p class="hint-text">Les deux demi-finales sont terminées.</p>
         <button id="t-btn-launch-finals" onclick="hostLaunchFinals()">▶ Lancer la petite finale et la finale</button>
       </div>`
    : (!isTHost() && semisReady && !ko.final)
      ? `<p class="hint-text t-bracket-waiting-host">⏳ Les demi-finales sont terminées — en attente que l'hôte lance la petite finale et la finale.</p>`
      : '';

  document.getElementById('t-knockout-list').innerHTML = `
    <div class="t-bracket-tree">
      <div class="t-bracket-stage">
        <div class="t-bracket-stage-label">Demi-finales</div>
        ${tBracketCardHtml('🥉 Demi-finale 1', ko.semi1)}
        ${tBracketCardHtml('🥉 Demi-finale 2', ko.semi2)}
      </div>
      <div class="t-bracket-arrow">➜</div>
      <div class="t-bracket-stage">
        <div class="t-bracket-stage-label">Finale &amp; petite finale</div>
        ${tBracketCardHtml('🏆 Finale', ko.final, 't-bracket-final')}
        ${tBracketCardHtml('🥈 Petite finale (3e/4e)', ko.bronze, 't-bracket-bronze')}
      </div>
    </div>
    ${launchHtml}
  `;
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
