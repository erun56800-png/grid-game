// ============================================================
//  CONFIGURATION FIREBASE  ← REMPLACEZ PAR VOS VALEURS
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

// ============================================================
//  CONSTANTES DU JEU
// ============================================================
const GRID_SIZE        = 10;   // 10×10 cases
const CELL_SIZE        = 50;   // pixels par case
const DEFAULT_WIN_SCORE     = 20;
const DEFAULT_INIT_OBJECTS = 15;
const DEFAULT_MIN_MOVES    = 1;
const DEFAULT_MAX_MOVES    = 10;
const DEFAULT_TRAP_COUNT = 10;   // nombre de cases pièges par défaut
const DIRECTIONS       = ['N', 'E', 'S', 'W'];
const DIR_VECTORS      = { N:[0,-1], E:[1,0], S:[0,1], W:[-1,0] };
const DEFAULT_REJOIN_WINDOW_MS = 120000; // 2 min par défaut pour rejoindre une nouvelle partie
const PRESENCE_HEARTBEAT_MS    = 10000;  // fréquence du battement de cœur de présence
const PRESENCE_STALE_MS        = 15000;  // au-delà, un "online: true" est considéré périmé

// Couleurs joueurs
const PLAYER_COLORS  = ['#4CAF50','#2196F3','#FF5722','#9C27B0',
                         '#00BCD4','#FF9800','#E91E63','#8BC34A'];

// Icônes + libellés (info-bulle) pour la file de commandes
const ACTION_ICONS = {
  forward:   '⬆',
  backward:  '⬇',
  turnLeft:  '↺',
  turnRight: '↻',
  pickup:    '📦',
  moveN:     '⬆',
  moveE:     '➡',
  moveS:     '⬇',
  moveW:     '⬅'
};
const ACTION_TITLES = {
  forward:   'Avancer',
  backward:  'Reculer',
  turnLeft:  'Pivoter à gauche',
  turnRight: 'Pivoter à droite',
  pickup:    'Ramasser',
  moveN:     'Nord',
  moveE:     'Est',
  moveS:     'Sud',
  moveW:     'Ouest'
};

// Correspondance action absolue → direction
const ABS_DIR = { moveN: 'N', moveE: 'E', moveS: 'S', moveW: 'W' };

// ============================================================
//  ÉTAT LOCAL
// ============================================================
let db, roomRef;
let myId       = null;
let myName     = '';
let roomCode   = '';
let amSpectator = false;
let gameState  = null;   // copie locale du state Firebase
let isMyTurn   = false;
let canvas, ctx;

// ── Hôte de la salle ──
let myHostToken     = null;  // jeton local prouvant le statut d'hôte (indépendant du pseudo)
let hostTokenParam   = null; // jeton lu dans l'URL (?host=...) avant vérification
let hostActivityInterval = null;
let presenceHeartbeatInterval = null;

// ── Chat ──
let mySessionId    = 'sess-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
let chatLastSeenTs = null;   // null = pas encore initialisé (pas d'alerte pour l'historique existant)
let chatUnreadCount = 0;
let chatFlashTimeoutId = null;

// ── Mode différé ──
let gameMode         = 'deferred'; // 'direct' | 'deferred' — différé par défaut
let commandQueue      = [];        // actions en attente (mode différé)
let previewOverride   = null;      // aperçu local {x,y,direction,objects}
let showGhostPreview  = false;     // affichage du pion fantôme (désactivé par défaut)

// ── Journal ──
let journalVisible = false;

// ── Son / alerte de tour ──
let audioCtx = null;
let flashTimeoutId = null;
let nextTurnBannerTimeout = null;

// ── Revanche ──
let rematchIntervalId   = null;
let rematchScheduledFor = null;

// ── Minuteur de tour ──
let turnTimerInterval = null;
let turnTimerDeadline = null;
let lastBeepSecond    = null;

// ============================================================
//  INITIALISATION FIREBASE
// ============================================================
firebase.initializeApp(firebaseConfig);
db = firebase.database();

// Pré-remplir le code de salle et/ou le pseudo depuis l'URL (?room=XXXX&name=YYY&host=TOKEN)
// Un lien personnel de reconnexion (room+name) ou un lien hôte (room+host)
// rejoint automatiquement la partie, sans clic supplémentaire sur "Rejoindre".
window.addEventListener('DOMContentLoaded', () => {
  setGameModeLocal(gameMode); // synchronise l'affichage (file de commandes) avec le mode par défaut

  const historyList = document.getElementById('history-list');
  if (historyList) {
    historyList.addEventListener('click', (e) => {
      const btn = e.target.closest('.history-join-btn');
      if (!btn) return;
      const entry = btn.closest('.history-room-entry');
      const code = entry && entry.__roomCode;
      if (code) joinRoomFromHistory(code);
    });
  }

  const hostActivityList = document.getElementById('host-activity-list');
  if (hostActivityList) {
    hostActivityList.addEventListener('change', (e) => {
      const cb = e.target.closest('.auto-skip-checkbox');
      if (!cb) return;
      const playerId = cb.dataset.playerId;
      if (playerId) hostSetAutoSkip(playerId, cb.checked);
    });
  }

  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  const nameParam  = params.get('name');
  const hostParam  = params.get('host');
  if (roomParam) document.getElementById('room-code').value = roomParam.toUpperCase();
  if (nameParam)  document.getElementById('player-name').value = nameParam;
  if (hostParam)  hostTokenParam = hostParam;

  if (roomParam && (nameParam || hostParam)) {
    proceedFromLogin();
  }
});

// ============================================================
//  UTILITAIRES : identifiant stable de joueur
// ============================================================
function slugifyName(name) {
  return name.toString().trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'joueur';
}
function playerIdFor(name) {
  return 'player_' + slugifyName(name);
}
function generateHostToken() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'host-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function randomMovesFromSettings(settings) {
  const min = (settings && settings.minMoves) || DEFAULT_MIN_MOVES;
  const max = (settings && settings.maxMoves) || DEFAULT_MAX_MOVES;
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

// ============================================================
//  RÉGLAGES AVANCÉS (écran de connexion)
// ============================================================
function toggleAdvancedSettings() {
  const el = document.getElementById('advanced-settings');
  el.style.display = (el.style.display === 'none') ? 'block' : 'none';
}

function toggleTrapCountRow() {
  const enabled = document.getElementById('traps-enabled-checkbox').checked;
  document.getElementById('trap-count-row').style.display = enabled ? 'block' : 'none';
}

// ============================================================
//  ÉCRAN DE CONNEXION → REJOINDRE / CRÉER UNE PARTIE
// ============================================================
async function proceedFromLogin() {
  myName      = document.getElementById('player-name').value.trim();
  roomCode    = document.getElementById('room-code').value.trim().toUpperCase();
  amSpectator = document.getElementById('spectator-checkbox').checked;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!roomCode) { errEl.textContent = 'Entrez un code de partie.'; return; }

  const checkRef = db.ref('rooms/' + roomCode);
  const snap = await checkRef.once('value');

  if (snap.exists()) {
    const state = snap.val();

    // Lien de reconfiguration totale : le jeton dans l'URL redonne le statut
    // d'hôte ET reconnecte automatiquement en tant qu'hôte d'origine (le
    // joueur existant s'il en était un, ou en spectateur sinon) — sans
    // redemander de pseudo, et sans jamais créer un nouveau joueur.
    if (hostTokenParam && state.settings && state.settings.hostToken === hostTokenParam) {
      myHostToken = hostTokenParam;

      const hostPlayerId = state.settings.hostId;
      const hostPlayer    = hostPlayerId ? (state.players || {})[hostPlayerId] : null;

      if (hostPlayer) {
        amSpectator = false;
        myName = hostPlayer.name;
        await joinExistingRoom(state, hostPlayerId, hostPlayer);
      } else {
        amSpectator = true;
        await enterAsSpectator();
      }
      return;
    }

    if (!amSpectator && !myName) { errEl.textContent = 'Entrez votre pseudo.'; return; }

    if (amSpectator) {
      await enterAsSpectator();
      return;
    }

    const candidateId = playerIdFor(myName);
    const existingPlayer = (state.players || {})[candidateId];

    // "online" est mis à jour via onDisconnect() côté Firebase, qui a un
    // délai de détection (parfois jusqu'à une minute) : après une fermeture
    // involontaire d'onglet, ce champ peut rester "true" un moment alors que
    // plus personne n'est réellement connecté. On ne bloque donc que si un
    // battement de cœur récent confirme qu'un autre onglet est VRAIMENT actif.
    const heartbeatIsFresh = existingPlayer &&
      (Date.now() - (existingPlayer.lastSeenAt || 0)) < PRESENCE_STALE_MS;

    if (existingPlayer && existingPlayer.online === true && heartbeatIsFresh) {
      errEl.textContent = "Ce joueur est déjà dans la salle (fermez l'autre onglet ou choisissez un autre pseudo).";
      return;
    }
    await joinExistingRoom(state, candidateId, existingPlayer);
  } else {
    if (!amSpectator && !myName) { errEl.textContent = 'Entrez votre pseudo.'; return; }
    // La salle n'existe pas encore : on peut la créer, y compris en restant spectateur
    // (l'hôte n'est alors pas un joueur actif — utile pour un affichage projeté en classe).
    document.getElementById('host-settings').style.display = 'block';
    document.getElementById('btn-join').style.display = 'none';
  }
}

async function createRoomWithSettings() {
  const movementMode    = document.querySelector('input[name="movement-mode"]:checked').value;
  const modeLocked       = document.getElementById('lock-mode-checkbox').checked;
  const expectedPlayers  = Math.max(1, parseInt(document.getElementById('expected-players').value) || 2);
  const gameModePolicy   = document.getElementById('game-mode-policy').value;
  const ghostAllowed     = document.getElementById('ghost-allowed-checkbox').checked;
  const minMoves         = Math.max(1, parseInt(document.getElementById('min-moves').value) || DEFAULT_MIN_MOVES);
  const maxMoves         = Math.max(minMoves, parseInt(document.getElementById('max-moves').value) || DEFAULT_MAX_MOVES);
  const winScore         = Math.max(1, parseInt(document.getElementById('win-score-input').value) || DEFAULT_WIN_SCORE);
  const initObjects      = Math.max(1, parseInt(document.getElementById('init-objects-input').value) || DEFAULT_INIT_OBJECTS);
  const turnTimeLimit    = Math.max(0, parseInt(document.getElementById('turn-time-limit').value) || 0);
  const trapsEnabled     = document.getElementById('traps-enabled-checkbox').checked;
  const trapCount        = Math.max(0, parseInt(document.getElementById('trap-count-input').value) || 0);
  const preAssignMoves   = document.getElementById('preassign-moves-checkbox').checked;
  const rejoinWindowMs   = Math.max(10, parseInt(document.getElementById('rejoin-window-input').value) || 120) * 1000;

  const errEl = document.getElementById('login-error');
  const hostToken = generateHostToken();
  myHostToken = hostToken;

  roomRef = db.ref('rooms/' + roomCode);

  let hostId = null;
  if (!amSpectator) {
    myId   = playerIdFor(myName);
    hostId = myId;
  }

  const settings = {
    movementMode, modeLocked, hostId, hostToken, expectedPlayers,
    gameModePolicy, ghostAllowed,
    minMoves, maxMoves, winScore, initObjects, turnTimeLimit,
    trapsEnabled, trapCount, preAssignMoves, rejoinWindowMs
  };

  const initialState = createInitialState(settings);
  if (!amSpectator) {
    initialState.players[myId] = createPlayer(myName, 0, movementMode);
  }

  await roomRef.set(initialState);
  await pushLog(amSpectator ? "Salle créée par l'hôte (spectateur)" : `Partie créée par ${myName}`);

  setupPresence();
  if (amSpectator) {
    await enterAsSpectator();
  } else {
    enterGameScreen();
  }
}

async function joinExistingRoom(state, candidateId, existingPlayer) {
  myId    = candidateId;
  roomRef = db.ref('rooms/' + roomCode);

  if (existingPlayer) {
    // Reconnexion : le joueur retrouve son score et sa position
    await roomRef.child('players/' + myId + '/online').set(true);
    await pushLog(`${myName} s'est reconnecté à la partie`);
  } else {
    const playerCount = Object.keys(state.players || {}).length;
    const colorIndex  = playerCount % PLAYER_COLORS.length;
    const defaultMode = (state.settings && state.settings.movementMode) || 'relative';
    const newPlayer   = createPlayer(myName, colorIndex, defaultMode);

    if (state.status === 'playing') {
      const preAssign = state.settings ? state.settings.preAssignMoves !== false : true;
      if (preAssign) {
        newPlayer.movesLeft = randomMovesFromSettings(state.settings);
      }
    }

    await roomRef.child('players/' + myId).set(newPlayer);

    if (state.status === 'playing') {
      const newOrder = [...(state.playerOrder || []), myId];
      await roomRef.child('playerOrder').set(newOrder);
      await pushLog(`${myName} rejoint la partie en cours !`);
    } else {
      await pushLog(`${myName} a rejoint la partie`);
    }
  }

  setupPresence();
  enterGameScreen();
}

function setupPresence() {
  if (!myId) return; // spectateur : pas de fiche joueur à suivre
  const myPlayerRef  = roomRef.child('players/' + myId);
  const myOnlineRef  = myPlayerRef.child('online');
  const connectedRef = db.ref('.info/connected');
  connectedRef.on('value', (snap) => {
    if (snap.val() === true) {
      myOnlineRef.onDisconnect().set(false);
      myOnlineRef.set(true);
      myPlayerRef.child('lastSeenAt').set(Date.now());
    }
  });

  // Battement de cœur régulier : permet de distinguer un "online: true"
  // encore valide d'un indicateur périmé après une fermeture involontaire
  // d'onglet (le onDisconnect de Firebase met du temps à se déclencher).
  clearInterval(presenceHeartbeatInterval);
  presenceHeartbeatInterval = setInterval(() => {
    myPlayerRef.child('lastSeenAt').set(Date.now());
  }, PRESENCE_HEARTBEAT_MS);
}

function enterGameScreen() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('display-room').textContent   = roomCode;
  document.getElementById('display-player').textContent = myName;

  canvas = document.getElementById('game-canvas');
  ctx    = canvas.getContext('2d');

  roomRef.on('value', onStateUpdate);
  startHostActivityTicker();
}

async function enterAsSpectator() {
  myId    = null;
  roomRef = db.ref('rooms/' + roomCode);

  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('display-room').textContent   = roomCode;
  document.getElementById('display-player').textContent = '👁 Spectateur';

  canvas = document.getElementById('game-canvas');
  ctx    = canvas.getContext('2d');

  // Masquer tout ce qui ne concerne que les joueurs actifs
  const idsToHide = [
    'controls', 'mode-switch', 'ghost-toggle', 'queue-panel',
    'waiting-msg', 'moves-left-line', 'my-score-line'
  ];
  idsToHide.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  const personalLinkBtn = document.querySelectorAll('#room-info .small-btn')[0];
  if (personalLinkBtn) personalLinkBtn.style.display = 'none';
  const feedback = document.getElementById('personal-link-feedback');
  if (feedback) feedback.style.display = 'none';

  roomRef.on('value', onStateUpdate);
  startHostActivityTicker();
}

function startHostActivityTicker() {
  clearInterval(hostActivityInterval);
  hostActivityInterval = setInterval(() => {
    if (gameState && gameState.status === 'playing' && isHost()) {
      renderHostActivityList();
      renderHostQuickBar();
    }
  }, 1000);
}

// ============================================================
//  LIENS D'INVITATION
// ============================================================
function getInviteLink() {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', roomCode);
  return url.toString();
}
function getPersonalLink() {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', roomCode);
  url.searchParams.set('name', myName);
  return url.toString();
}
function getHostLink() {
  const token = myHostToken || (gameState && gameState.settings && gameState.settings.hostToken) || '';
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', roomCode);
  url.searchParams.set('host', token);
  return url.toString();
}
async function copyInviteLink() {
  try {
    await navigator.clipboard.writeText(getInviteLink());
    showLinkFeedback('✅ Lien copié !');
  } catch (e) { window.prompt('Copiez ce lien :', getInviteLink()); }
}
async function copyPersonalLink() {
  try {
    await navigator.clipboard.writeText(getPersonalLink());
    showLinkFeedback('✅ Lien personnel copié !');
  } catch (e) { window.prompt('Copiez ce lien :', getPersonalLink()); }
}
async function copyHostLink() {
  try {
    await navigator.clipboard.writeText(getHostLink());
    showFeedbackIn('host-link-feedback', 'lobby-host-link-feedback', '✅ Lien hôte copié !');
  } catch (e) { window.prompt('Copiez ce lien (à garder secret) :', getHostLink()); }
}

function showLinkFeedback(msg) {
  const lobbyScreen = document.getElementById('screen-lobby');
  const lobbyFeedback = document.getElementById('invite-link-feedback');
  if (lobbyFeedback && lobbyScreen && lobbyScreen.classList.contains('active')) {
    lobbyFeedback.textContent = msg;
    setTimeout(() => { lobbyFeedback.textContent = ''; }, 2500);
    return;
  }
  const gameFeedback = document.getElementById('personal-link-feedback');
  if (gameFeedback) {
    gameFeedback.textContent = msg;
    setTimeout(() => { gameFeedback.textContent = ''; }, 2500);
    return;
  }
  addLocalLog(msg);
}

// Affiche un message de confirmation dans le premier élément visible parmi les deux fournis
// (utile quand la même action est disponible depuis plusieurs écrans, ex. lien hôte
// depuis la salle d'attente ou depuis l'écran de jeu).
function showFeedbackIn(primaryId, secondaryId, msg) {
  const primary = document.getElementById(primaryId);
  const el = (primary && primary.offsetParent !== null) ? primary : document.getElementById(secondaryId);
  if (!el) return;
  el.textContent = msg;
  setTimeout(() => { el.textContent = ''; }, 2500);
}

// ============================================================
//  QR CODE (salle d'attente + espace de jeu)
// ============================================================
function renderQRCode(containerId, size) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = '';

  if (typeof qrcode === 'undefined') {
    // La bibliothèque QR (vendor/qrcode.js) n'a pas pu se charger — fichier
    // manquant, chemin cassé, etc. On l'affiche clairement au lieu de
    // laisser un carré blanc muet.
    container.classList.add('qr-unavailable');
    container.innerHTML = `
      <p class="qr-fallback-msg">📵 QR code indisponible<br>(bibliothèque non chargée)</p>
      <p class="qr-fallback-msg">Utilisez le lien ci-dessus à la place.</p>
    `;
    console.warn('QR code : la bibliothèque qrcode (vendor/qrcode.js) n\'est pas chargée.');
    return;
  }

  try {
    container.classList.remove('qr-unavailable');
    // typeNumber 0 = taille auto-détectée selon la longueur du texte,
    // niveau de correction d'erreur H (le plus robuste).
    const qr = qrcode(0, 'H');
    qr.addData(getInviteLink());
    qr.make();

    const px = size || 160;
    container.innerHTML = qr.createSvgTag({ scalable: true });
    const svg = container.querySelector('svg');
    if (svg) {
      svg.style.width  = px + 'px';
      svg.style.height = px + 'px';
      svg.style.display = 'block';
    }
  } catch (e) {
    container.classList.add('qr-unavailable');
    container.innerHTML = `<p class="qr-fallback-msg">📵 QR code indisponible<br>Utilisez le lien ci-dessus.</p>`;
    console.warn('QR code : erreur lors de la génération.', e);
  }
}

function openQrModal() {
  document.getElementById('qrcode-room-label').textContent = `Salle : ${roomCode}`;
  renderQRCode('game-qrcode', 260);
  const linkInput = document.getElementById('modal-qr-link');
  if (linkInput) linkInput.value = getInviteLink();
  document.getElementById('modal-qrcode').style.display = 'flex';
}
function closeQrModal() {
  document.getElementById('modal-qrcode').style.display = 'none';
}
async function copyLinkFromQrModal() {
  try {
    await navigator.clipboard.writeText(getInviteLink());
    showFeedbackIn('modal-qr-link-feedback', 'modal-qr-link-feedback', '✅ Lien copié !');
  } catch (e) { window.prompt('Copiez ce lien :', getInviteLink()); }
}

// ============================================================
//  HISTORIQUE DES SALLES (écran de connexion)
//  Liste toutes les salles déjà créées — jamais les pseudos des joueurs,
//  seulement des informations agrégées (statut, nombre de joueurs, dates).
// ============================================================
let historyRoomsRef = null;

const ROOM_STATUS_LABELS = {
  waiting:  '🕓 En attente',
  playing:  '🎮 En cours',
  finished: '🏆 Partie terminée',
  ended:    '⏹ Terminée'
};

function openHistoryScreen() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('screen-history').classList.add('active');

  const list = document.getElementById('history-list');
  if (list) list.innerHTML = '<p class="hint-text">Chargement…</p>';

  historyRoomsRef = db.ref('rooms');
  historyRoomsRef.on('value', renderRoomHistory, (err) => {
    if (list) {
      list.innerHTML = `<p class="qr-fallback-msg" style="max-width:none;color:#e94560">
        ⚠️ Impossible de charger l'historique (accès refusé par les règles de sécurité Firebase ?).
      </p>`;
    }
    console.warn("Historique des salles : erreur de lecture de 'rooms'.", err);
  });
}

function closeHistoryScreen() {
  if (historyRoomsRef) {
    historyRoomsRef.off('value', renderRoomHistory);
    historyRoomsRef = null;
  }
  document.getElementById('screen-history').classList.remove('active');
  document.getElementById('screen-login').classList.add('active');
}

function renderRoomHistory(snap) {
  const list = document.getElementById('history-list');
  if (!list) return;

  if (!snap.exists()) {
    list.innerHTML = '<p class="hint-text">Aucune salle pour le moment.</p>';
    return;
  }

  const rooms = [];
  snap.forEach((child) => {
    const room = child.val() || {};
    const players = room.players || {};
    const logEntries = Object.values(room.log || {});
    const earliestLog = logEntries.reduce(
      (min, e) => (e && e.ts && (!min || e.ts < min)) ? e.ts : min, null
    );
    rooms.push({
      code:        child.key,
      status:      room.status || 'waiting',
      playerCount: Object.keys(players).length,
      gamesPlayed: Object.keys(room.history || {}).length,
      createdAt:   room.createdAt || earliestLog || null
    });
  });

  rooms.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  list.innerHTML = rooms.map((r, i) => {
    const dateTxt = r.createdAt
      ? new Date(r.createdAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      : 'date inconnue';
    const statusTxt = escapeHtml(ROOM_STATUS_LABELS[r.status] || r.status);
    return `<div class="history-room-entry" data-index="${i}">
      <div class="history-room-head">
        <span class="history-room-code">${escapeHtml(r.code)}</span>
        <span class="history-room-status">${statusTxt}</span>
      </div>
      <div class="history-room-meta">👥 ${r.playerCount} joueur(s) · 🔁 ${r.gamesPlayed} partie(s) jouée(s) · 🗓 ${dateTxt}</div>
      <button class="small-btn history-join-btn" type="button">➡ Rejoindre cette salle</button>
    </div>`;
  }).join('');

  // Le code de salle est un texte libre saisi par l'utilisateur : on l'attache
  // comme propriété JS (jamais réinjecté dans du HTML) pour éviter tout souci
  // d'échappement dans un attribut, plutôt que de l'interpoler dans l'attribut.
  list.querySelectorAll('.history-room-entry').forEach((el) => {
    const idx = Number(el.dataset.index);
    el.__roomCode = rooms[idx] ? rooms[idx].code : null;
  });
}

function joinRoomFromHistory(code) {
  closeHistoryScreen();
  document.getElementById('room-code').value = code;
  const nameInput = document.getElementById('player-name');
  if (nameInput) nameInput.focus();
}

// ============================================================
//  CRÉATION D'ÉTAT INITIAL
// ============================================================
function createInitialState(settings) {
  const objects = generateObjects(settings.initObjects || DEFAULT_INIT_OBJECTS, {});
  const traps   = settings.trapsEnabled
    ? generateTraps(settings.trapCount != null ? settings.trapCount : DEFAULT_TRAP_COUNT, objects)
    : {};
  return {
    status:        'waiting',   // waiting | playing | finished | ended
    turn:          0,
    currentPlayer: null,
    playerOrder:   [],
    players:       {},
    objects:       objects,
    traps:         traps,
    log:           {},
    settings:      settings,
    gameNumber:    1,
    history:       {},
    rematchVotes:  {},
    createdAt:     Date.now()
  };
}

function createPlayer(name, colorIndex, movementMode) {
  return {
    name:         name,
    colorIndex:   colorIndex,
    x:            Math.floor(Math.random() * GRID_SIZE),
    y:            Math.floor(Math.random() * GRID_SIZE),
    direction:    DIRECTIONS[Math.floor(Math.random() * 4)],
    score:        0,
    movesLeft:    0,
    movesUsed:    0,
    movementMode: movementMode || 'relative',
    totalActiveMs: 0,
    turnScoreGained: 0, // objets ramassés depuis le début du tour en cours (mode direct)
    autoSkip:     false, // si vrai, ce joueur passe automatiquement son tour à chaque fois
    online:       true
  };
}

// ============================================================
//  GÉNÉRATION D'OBJETS ET DE PIÈGES
// ============================================================
function generateObjects(count, existingObjects, avoidTraps) {
  const objects = { ...existingObjects };
  const traps = avoidTraps || {};
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < 500) {
    attempts++;
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    const key = `${x}_${y}`;
    if (!objects[key] && !traps[key]) {
      objects[key] = { x, y, type: 'star' };
      placed++;
    }
  }
  return objects;
}

function generateTraps(count, avoidObjects) {
  const traps = {};
  const avoid = avoidObjects || {};
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < 500) {
    attempts++;
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    const key = `${x}_${y}`;
    if (!avoid[key] && !traps[key]) {
      traps[key] = true;
      placed++;
    }
  }
  return traps;
}

// ============================================================
//  RÉGLAGES DYNAMIQUES DE LA SALLE
// ============================================================
function getSetting(key, fallback) {
  return (gameState && gameState.settings && gameState.settings[key] !== undefined)
    ? gameState.settings[key] : fallback;
}
function currentWinScore()    { return getSetting('winScore', DEFAULT_WIN_SCORE); }
function currentInitObjects() { return getSetting('initObjects', DEFAULT_INIT_OBJECTS); }

function randomMoves() {
  const min = getSetting('minMoves', DEFAULT_MIN_MOVES);
  const max = getSetting('maxMoves', DEFAULT_MAX_MOVES);
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

// ============================================================
//  MISE À JOUR DE L'ÉTAT (listener Firebase)
// ============================================================
function onStateUpdate(snap) {
  if (!snap.exists()) return;
  gameState = snap.val();

  // Garantir les structures
  if (!gameState.players)      gameState.players      = {};
  if (!gameState.objects)      gameState.objects      = {};
  if (!gameState.traps)        gameState.traps        = {};
  if (!gameState.log)          gameState.log          = {};
  if (!gameState.settings)     gameState.settings     = { movementMode: 'relative', modeLocked: false, hostId: null, expectedPlayers: 2 };
  if (!gameState.rematchVotes) gameState.rematchVotes = {};
  if (!gameState.history)      gameState.history      = {};

  updateScreenForStatus();

  if (gameState.status === 'waiting') {
    hideFinishedModal(); // au cas où l'on revient d'une partie terminée
    renderLobby();
    return;
  }

  const wasMyTurn = isMyTurn;
  isMyTurn = (gameState.currentPlayer === myId && gameState.status === 'playing');

  if (!isMyTurn) {
    commandQueue = [];
    previewOverride = null;
    stopTurnTimer();
  }

  updateUI();
  drawGrid();

  if (isMyTurn && gameMode === 'deferred' && commandQueue.length > 0) {
    renderDeferredPreview();
  }

  if (!wasMyTurn && isMyTurn) {
    playTurnSound();
    flashTurnAlert();
    startTurnTimer();
    enforceForcedSettingsForNewTurn();
  }

  if (gameState.status === 'finished' || gameState.status === 'ended') {
    handleGameFinished();
  } else {
    hideFinishedModal();
  }
}

function isHost() {
  if (!gameState || !gameState.settings) return false;
  const settings = gameState.settings;
  if (myHostToken && settings.hostToken && myHostToken === settings.hostToken) return true;
  return myId !== null && settings.hostId === myId;
}

function updateScreenForStatus() {
  const status = gameState.status;
  document.getElementById('screen-lobby').classList.toggle('active', status === 'waiting');
  document.getElementById('screen-game').classList.toggle('active', status !== 'waiting');
}

// ============================================================
//  SALLE D'ATTENTE (LOBBY)
// ============================================================
function renderLobby() {
  document.getElementById('lobby-room-code').textContent = roomCode;
  const linkInput = document.getElementById('lobby-invite-link');
  if (linkInput) linkInput.value = getInviteLink();
  const personalRow = document.getElementById('lobby-personal-link');
  if (personalRow) {
    personalRow.value = getPersonalLink();
    personalRow.parentElement.style.display = amSpectator ? 'none' : 'flex';
  }

  renderQRCode('lobby-qrcode', 150);

  const players = gameState.players || {};
  const rejoinStatus = gameState.rejoinStatus || {};
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = Object.entries(players).map(([id, p]) => {
    const badge = rejoinStatus[id] === 'accepted'
      ? '<span class="badge badge-accepted">✅ A accepté</span>'
      : rejoinStatus[id] === 'left'
        ? '<span class="badge badge-left">❌ A quitté</span>'
        : '';
    return `<li class="${p.online === false ? 'offline-item' : ''}">${p.name}${p.online === false ? ' (hors ligne)' : ''}${badge}</li>`;
  }).join('');

  const expected = (gameState.settings && gameState.settings.expectedPlayers) || 2;
  document.getElementById('lobby-player-count').textContent =
    `${Object.keys(players).length} / ${expected} joueur(s)`;

  const hostControls = document.getElementById('lobby-host-controls');
  const waitMsg       = document.getElementById('lobby-wait-msg');
  if (isHost()) {
    hostControls.style.display = 'block';
    waitMsg.style.display = 'none';
  } else {
    hostControls.style.display = 'none';
    waitMsg.style.display = 'block';
  }
}

async function launchGameFromLobby() {
  await startRound();
}

// Démarre (ou relance) une partie : sert au tout premier lancement depuis la
// salle d'attente comme au redémarrage d'une nouvelle partie après une revanche.
// Réinitialise systématiquement position/score/objets/pièges pour chaque joueur
// actuellement dans la salle.
async function startRound() {
  const players = gameState.players || {};
  const ids = Object.keys(players);
  if (ids.length === 0) return;

  const shuffled  = [...ids].sort(() => Math.random() - 0.5);
  // Ne démarre pas sur un joueur qui a coché "passer automatiquement", sauf
  // si tout le monde l'a coché (il faut bien que quelqu'un commence).
  const firstId   = shuffled.find(id => !players[id].autoSkip) || shuffled[0];
  const preAssign = getSetting('preAssignMoves', true);
  const modeLocked  = getSetting('modeLocked', false);
  const imposedMode = getSetting('movementMode', 'relative');

  const resetPlayers = {};
  ids.forEach(id => {
    resetPlayers[id] = {
      ...players[id],
      x:             Math.floor(Math.random() * GRID_SIZE),
      y:             Math.floor(Math.random() * GRID_SIZE),
      direction:     DIRECTIONS[Math.floor(Math.random() * 4)],
      score:         0,
      movesUsed:     0,
      movesLeft:     0,
      totalActiveMs: 0,
      turnScoreGained: 0,
      movementMode:  modeLocked ? imposedMode : (players[id].movementMode || imposedMode)
    };
  });
  if (preAssign) {
    shuffled.forEach(id => { resetPlayers[id].movesLeft = randomMoves(); });
  } else {
    resetPlayers[firstId].movesLeft = randomMoves();
  }

  const hasHistory = Object.keys(gameState.history || {}).length > 0;
  const gameNumber  = hasHistory ? (gameState.gameNumber || 1) + 1 : (gameState.gameNumber || 1);

  const newObjects   = generateObjects(currentInitObjects(), {});
  const trapsEnabled = getSetting('trapsEnabled', false);
  const trapCount    = getSetting('trapCount', DEFAULT_TRAP_COUNT);
  const newTraps      = trapsEnabled ? generateTraps(trapCount, newObjects) : {};

  const updates = {
    status:        'playing',
    turn:          1,
    currentPlayer: firstId,
    playerOrder:   shuffled,
    players:       resetPlayers,
    objects:       newObjects,
    traps:         newTraps,
    winner:        null,
    rematchVotes:  {},
    rejoinStatus:  null,
    gameNumber:    gameNumber,
    turnStartedAt: Date.now()
  };

  await roomRef.update(updates);
  const label = hasHistory ? `🔁 Nouvelle partie (partie n°${gameNumber})` : 'Tour 1';
  await pushLog(`${label} — ${resetPlayers[firstId].name} commence (${resetPlayers[firstId].movesLeft} déplacements)`);
}

// ============================================================
//  MODE DE DÉPLACEMENT (relatif / absolu) — choix individuel par joueur,
//  sauf verrouillage par l'hôte (auquel cas le mode imposé s'applique à tous).
// ============================================================
function effectiveMovementMode(player) {
  const settings = (gameState && gameState.settings) || {};
  if (settings.modeLocked) return settings.movementMode || 'relative';
  return (player && player.movementMode) || settings.movementMode || 'relative';
}

async function changeMovementMode(mode) {
  if (amSpectator || !myId) return;
  const settings = gameState.settings || {};
  if (settings.modeLocked) {
    document.getElementById('movement-mode-select').value = settings.movementMode || 'relative';
    addLocalLog("🔒 Le mode de déplacement est imposé par l'hôte.");
    return;
  }
  await roomRef.update({ [`players/${myId}/movementMode`]: mode });
}

function syncMovementModeSelect() {
  const sel = document.getElementById('movement-mode-select');
  if (!sel) return;
  const settings = gameState.settings || {};
  const myPlayer = myId ? gameState.players[myId] : null;
  sel.value = effectiveMovementMode(myPlayer);
  sel.disabled = amSpectator || !myId || !!settings.modeLocked;
}

function updateControlPad() {
  const myPlayer = myId ? gameState.players[myId] : null;
  const mode = effectiveMovementMode(myPlayer);
  document.getElementById('controls-grid-relative').style.display = (mode === 'relative') ? 'grid' : 'none';
  document.getElementById('controls-grid-absolute').style.display = (mode === 'absolute') ? 'grid' : 'none';
}

// ============================================================
//  POLITIQUE DE MODE DIRECT/DIFFÉRÉ + FANTÔME (verrouillage hôte)
// ============================================================
function setGameModeLocal(mode) {
  gameMode = mode;
  const queuePanel = document.getElementById('queue-panel');
  if (queuePanel) queuePanel.style.display = (mode === 'deferred') ? 'block' : 'none';
}

// Affichage continu (sans danger : ne modifie jamais l'état d'un tour en cours).
// L'application effective d'un mode imposé se fait uniquement au début du
// prochain tour du joueur — voir enforceForcedSettingsForNewTurn().
function applyGameModePolicy() {
  const policy = (gameState.settings && gameState.settings.gameModePolicy) || 'free';
  const modeSwitch = document.getElementById('mode-switch');
  if (modeSwitch) modeSwitch.style.display = (policy === 'free') ? 'flex' : 'none';

  document.querySelectorAll('input[name="game-mode"]').forEach(r => { r.checked = (r.value === gameMode); });

  const ghostAllowed = gameState.settings ? gameState.settings.ghostAllowed !== false : true;
  const ghostToggle = document.getElementById('ghost-toggle');
  if (ghostToggle) {
    ghostToggle.style.display = (ghostAllowed && gameMode === 'deferred') ? 'block' : 'none';
  }
}

// Applique les réglages imposés par l'hôte (mode direct/différé, fantôme) au
// moment précis où mon tour commence — jamais en pleine action, pour ne pas
// perdre une file de commandes en cours de préparation.
function enforceForcedSettingsForNewTurn() {
  const settings = gameState.settings || {};
  const policy = settings.gameModePolicy || 'free';

  if (policy === 'forceDirect' && gameMode !== 'direct') {
    if (commandQueue.length > 0) addLocalLog('⚠️ Mode direct imposé par l\'hôte : file de commandes vidée.');
    setGameModeLocal('direct');
    commandQueue = [];
    previewOverride = null;
  } else if (policy === 'forceDeferred' && gameMode !== 'deferred') {
    setGameModeLocal('deferred');
  }

  const ghostAllowed = settings.ghostAllowed !== false;
  if (!ghostAllowed && showGhostPreview) {
    showGhostPreview = false;
    const cb = document.getElementById('ghost-checkbox');
    if (cb) cb.checked = false;
  }
}

// ============================================================
//  DISPATCH : mode direct ou mode différé
// ============================================================
function playerAction(action) {
  if (!isMyTurn) return;
  if (gameMode === 'deferred') {
    playerActionDeferred(action);
  } else {
    playerActionDirect(action);
  }
}

// ============================================================
//  DESCRIPTION TEXTUELLE D'UNE ACTION (pour le journal)
// ============================================================
function describeAction(action, name, newDir) {
  switch (action) {
    case 'forward':   return `${name} avance`;
    case 'backward':  return `${name} recule`;
    case 'turnLeft':  return `${name} pivote à gauche → ${newDir}`;
    case 'turnRight': return `${name} pivote à droite → ${newDir}`;
    case 'moveN':     return `${name} se déplace vers le Nord`;
    case 'moveS':     return `${name} se déplace vers le Sud`;
    case 'moveE':     return `${name} se déplace vers l'Est`;
    case 'moveW':     return `${name} se déplace vers l'Ouest`;
    default:          return '';
  }
}

const MOVE_ACTIONS = new Set(['forward', 'backward', 'moveN', 'moveE', 'moveS', 'moveW']);

// ============================================================
//  MODE DIRECT — envoi immédiat à Firebase
// ============================================================
async function playerActionDirect(action) {
  const player = gameState.players[myId];
  if (!player) return;

  if (action === 'pickup') {
    const key = `${player.x}_${player.y}`;
    if (gameState.objects[key]) {
      const newScore      = (player.score || 0) + 1;
      const newTurnGained = (player.turnScoreGained || 0) + 1;
      const updates = {
        [`players/${myId}/score`]:           newScore,
        [`players/${myId}/turnScoreGained`]: newTurnGained
      };
      updates[`objects/${key}`] = null;

      await roomRef.update(updates);
      await pushLog(`⭐ ${player.name} ramasse un objet ! Score : ${newScore}`);

      if (newScore >= currentWinScore()) {
        await finishGame(myId);
      }
    } else {
      addLocalLog('❌ Pas d\'objet ici !');
    }
    return;
  }

  if (player.movesLeft <= 0) {
    addLocalLog('❌ Plus de déplacements !');
    return;
  }

  const { state } = simulateQueue(player, gameState.objects, [action], gameState.traps);

  const updates = {
    [`players/${myId}/x`]:         state.x,
    [`players/${myId}/y`]:         state.y,
    [`players/${myId}/direction`]: state.direction,
    [`players/${myId}/movesLeft`]: state.movesLeft,
    [`players/${myId}/movesUsed`]: (player.movesUsed || 0) + 1
  };

  let logMsg;
  if (state.trapped) {
    // Un piège fait perdre tous les objets ramassés depuis le début du tour
    // (pas le score acquis avant ce tour).
    const lostStars = player.turnScoreGained || 0;
    if (lostStars > 0) {
      updates[`players/${myId}/score`] = Math.max(0, (player.score || 0) - lostStars);
    }
    updates[`players/${myId}/turnScoreGained`] = 0;
    logMsg = `💥 ${player.name} tombe dans un piège et reste bloqué ! Fin de son tour.` +
      (lostStars > 0 ? ` ${lostStars} objet(s) ramassé(s) ce tour sont repris.` : '');
  } else {
    logMsg = describeAction(action, player.name, state.direction);
  }

  await roomRef.update(updates);
  if (logMsg) await pushLog(logMsg);

  if (state.trapped) {
    await advanceTurn(gameState.objects);
  }
}

// ============================================================
//  SIMULATION PURE (utilisée par le mode différé et le mode direct)
//  Ne touche jamais Firebase : calcule un état hypothétique.
//  Gère les pièges : le joueur revient sur sa case précédente,
//  perd ses déplacements restants, et le reste de la file est ignoré.
// ============================================================
function simulateQueue(basePlayer, baseObjects, queue, traps) {
  const state = {
    x: basePlayer.x,
    y: basePlayer.y,
    direction: basePlayer.direction,
    movesLeft: basePlayer.movesLeft || 0,
    score: basePlayer.score || 0,
    trapped: false
  };
  const objects = { ...(baseObjects || {}) };
  const trapMap = traps || {};
  const pickedKeys = [];
  let movesUsed = 0;

  for (const action of queue) {
    if (state.trapped) break;

    if (ABS_DIR[action]) {
      const dir = ABS_DIR[action];
      const [dx, dy] = DIR_VECTORS[dir];
      const newX = clamp(state.x + dx, 0, GRID_SIZE - 1);
      const newY = clamp(state.y + dy, 0, GRID_SIZE - 1);
      state.movesLeft--;
      movesUsed++;
      if (trapMap[`${newX}_${newY}`]) {
        state.trapped = true;
        state.movesLeft = 0;
      } else {
        state.x = newX; state.y = newY; state.direction = dir;
      }
      continue;
    }

    switch (action) {
      case 'forward': {
        const [dx, dy] = DIR_VECTORS[state.direction];
        const newX = clamp(state.x + dx, 0, GRID_SIZE - 1);
        const newY = clamp(state.y + dy, 0, GRID_SIZE - 1);
        state.movesLeft--;
        movesUsed++;
        if (trapMap[`${newX}_${newY}`]) { state.trapped = true; state.movesLeft = 0; }
        else { state.x = newX; state.y = newY; }
        break;
      }
      case 'backward': {
        const [dx, dy] = DIR_VECTORS[state.direction];
        const newX = clamp(state.x - dx, 0, GRID_SIZE - 1);
        const newY = clamp(state.y - dy, 0, GRID_SIZE - 1);
        state.movesLeft--;
        movesUsed++;
        if (trapMap[`${newX}_${newY}`]) { state.trapped = true; state.movesLeft = 0; }
        else { state.x = newX; state.y = newY; }
        break;
      }
      case 'turnRight': {
        const idx = DIRECTIONS.indexOf(state.direction);
        state.direction = DIRECTIONS[(idx + 1) % 4];
        state.movesLeft--;
        movesUsed++;
        break;
      }
      case 'turnLeft': {
        const idx = DIRECTIONS.indexOf(state.direction);
        state.direction = DIRECTIONS[(idx + 3) % 4];
        state.movesLeft--;
        movesUsed++;
        break;
      }
      case 'pickup': {
        const key = `${state.x}_${state.y}`;
        if (objects[key]) {
          delete objects[key];
          state.score++;
          pickedKeys.push(key);
        }
        break;
      }
    }
  }

  // Un piège fait perdre tous les objets ramassés depuis le début de CE tour
  // (pas les objets déjà en score avant le tour) : le score revient à sa
  // valeur de départ. Les objets ramassés restent retirés du plateau.
  if (state.trapped) {
    state.score = basePlayer.score || 0;
  }

  return { state, objects, pickedKeys, movesUsed };
}

// ============================================================
//  MODE DIFFÉRÉ : ajouter une commande à la file
// ============================================================
function playerActionDeferred(action) {
  const player = gameState.players[myId];
  if (!player) return;

  const before = simulateQueue(player, gameState.objects, commandQueue, gameState.traps);

  if (before.state.trapped) {
    addLocalLog('❌ Votre tour est déjà terminé (piège) — cliquez sur "Terminer mon tour".');
    return;
  }
  if (action !== 'pickup' && before.state.movesLeft <= 0) {
    addLocalLog('❌ Plus de déplacements disponibles !');
    return;
  }
  if (action === 'pickup') {
    const key = `${before.state.x}_${before.state.y}`;
    if (!before.objects[key]) {
      addLocalLog('❌ Pas d\'objet ici (selon la position prévue) !');
      return;
    }
  }

  commandQueue.push(action);
  renderDeferredPreview();
}

// ============================================================
//  MODE DIFFÉRÉ : effacer la dernière commande
// ============================================================
function undoLastCommand() {
  if (!isMyTurn || gameMode !== 'deferred') return;
  if (commandQueue.length === 0) return;
  commandQueue.pop();
  renderDeferredPreview();
}

// ============================================================
//  MODE DIFFÉRÉ : rafraîchir l'aperçu local
// ============================================================
function renderDeferredPreview() {
  const player = gameState.players[myId];
  if (!player) return;

  const { state, objects } = simulateQueue(player, gameState.objects, commandQueue, gameState.traps);

  previewOverride = {
    x: state.x,
    y: state.y,
    direction: state.direction,
    objects: objects
  };

  document.getElementById('moves-left').textContent = Math.max(0, state.movesLeft);
  document.getElementById('my-score').textContent    = state.score;

  updateQueueList();
  drawGrid();
}

function updateQueueList() {
  const list = document.getElementById('queue-list');
  if (!list) return;
  list.innerHTML = commandQueue.map(a => {
    const cls = a === 'pickup' ? ' queue-pickup' : '';
    return `<span class="queue-entry${cls}" title="${ACTION_TITLES[a] || a}">${ACTION_ICONS[a] || a}</span>`;
  }).join('');
}

// ============================================================
//  BASCULER ENTRE MODE DIRECT ET MODE DIFFÉRÉ (préférence locale)
// ============================================================
function setGameMode(mode) {
  const policy = (gameState.settings && gameState.settings.gameModePolicy) || 'free';
  if (policy !== 'free') return; // verrouillé par l'hôte

  if (commandQueue.length > 0) {
    addLocalLog('⚠️ File de commandes vidée suite au changement de mode.');
  }
  setGameModeLocal(mode);
  commandQueue = [];
  previewOverride = null;
  showGhostPreview = false;

  const ghostCheckbox = document.getElementById('ghost-checkbox');
  if (ghostCheckbox) ghostCheckbox.checked = false;

  const ghostAllowed = gameState.settings ? gameState.settings.ghostAllowed !== false : true;
  const ghostToggle = document.getElementById('ghost-toggle');
  if (ghostToggle) ghostToggle.style.display = (mode === 'deferred' && ghostAllowed) ? 'block' : 'none';

  updateUI();
  drawGrid();
}

function toggleGhostPreview(checked) {
  showGhostPreview = checked;
  drawGrid();
}

// ============================================================
//  DISPATCH FIN DE TOUR
// ============================================================
function handleEndTurnClick() {
  if (gameMode === 'deferred') {
    endTurnDeferred();
  } else {
    endTurn();
  }
}

// ============================================================
//  FIN DE TOUR — MODE DIRECT
// ============================================================
async function endTurn() {
  if (!isMyTurn) return;
  await advanceTurn(gameState.objects);
}

// ============================================================
//  FIN DE TOUR — MODE DIFFÉRÉ
//  Exécute toute la file de commandes d'un coup, puis passe la main
// ============================================================
async function endTurnDeferred() {
  if (!isMyTurn) return;
  const player = gameState.players[myId];
  if (!player) return;

  const { state: finalState, objects: objectsAfterPickup, pickedKeys, movesUsed } =
    simulateQueue(player, gameState.objects, commandQueue, gameState.traps);

  const playerUpdates = {
    [`players/${myId}/x`]:         finalState.x,
    [`players/${myId}/y`]:         finalState.y,
    [`players/${myId}/direction`]: finalState.direction,
    [`players/${myId}/score`]:     finalState.score,
    [`players/${myId}/movesLeft`]: Math.max(0, finalState.movesLeft),
    [`players/${myId}/movesUsed`]: (player.movesUsed || 0) + movesUsed
  };
  pickedKeys.forEach(key => { playerUpdates[`objects/${key}`] = null; });

  await roomRef.update(playerUpdates);

  if (finalState.trapped) {
    const lostMsg = pickedKeys.length > 0 ? ` ${pickedKeys.length} objet(s) ramassé(s) ce tour sont repris.` : '';
    await pushLog(`💥 ${player.name} tombe dans un piège pendant l'exécution de son tour ! Déplacements restants annulés.${lostMsg}`);
  } else {
    if (commandQueue.length > 0) {
      await pushLog(`📝 ${player.name} exécute ${commandQueue.length} commande(s) (mode différé)`);
    }
    if (pickedKeys.length > 0) {
      await pushLog(`⭐ ${player.name} ramasse ${pickedKeys.length} objet(s) ! Score : ${finalState.score}`);
    }
  }

  commandQueue = [];
  previewOverride = null;

  if (finalState.score >= currentWinScore()) {
    await finishGame(myId);
    return;
  }

  await advanceTurn(objectsAfterPickup);
}

// ============================================================
//  PASSER LA MAIN AU JOUEUR SUIVANT (partagé par les 2 modes)
// ============================================================
async function advanceTurn(objectsSnapshot, finishingId) {
  const state       = gameState;
  const activeId    = finishingId || myId;
  const playerOrder = state.playerOrder || Object.keys(state.players);
  const currentIdx  = playerOrder.indexOf(activeId);

  // Saute automatiquement les joueurs ayant coché "passer automatiquement",
  // sans jamais boucler indéfiniment si tout le monde l'a coché.
  let nextIdx = (currentIdx + 1) % playerOrder.length;
  const autoSkippedIds = [];
  let loops = 0;
  while (
    loops < playerOrder.length - 1 &&
    state.players[playerOrder[nextIdx]] &&
    state.players[playerOrder[nextIdx]].autoSkip === true
  ) {
    autoSkippedIds.push(playerOrder[nextIdx]);
    nextIdx = (nextIdx + 1) % playerOrder.length;
    loops++;
  }
  const nextId = playerOrder[nextIdx];

  const currentObjectsCount = Object.keys(objectsSnapshot || {}).length;
  const missing             = currentInitObjects() - currentObjectsCount;
  let newObjects            = { ...objectsSnapshot };
  if (missing > 0) {
    newObjects = generateObjects(missing, newObjects, state.traps);
  }

  const newTurn   = nextIdx === 0 ? (state.turn || 1) + 1 : (state.turn || 1);
  const preAssign = getSetting('preAssignMoves', true);

  // Temps passé actif par le joueur qui termine son tour (compteur cumulé,
  // affiché au panneau hôte).
  const activePlayerBefore = state.players[activeId];
  const elapsedForActive   = Date.now() - (state.turnStartedAt || Date.now());

  const updates = {
    currentPlayer: nextId,
    turn:          newTurn,
    objects:       newObjects,
    turnStartedAt: Date.now(),
    [`players/${activeId}/totalActiveMs`]: (activePlayerBefore ? (activePlayerBefore.totalActiveMs || 0) : 0) + elapsedForActive,
    [`players/${nextId}/turnScoreGained`]: 0
  };

  // Mode de déplacement imposé par l'hôte : appliqué au joueur suivant dès
  // le début de son tour (ne perturbe jamais un tour déjà en cours).
  if (state.settings && state.settings.modeLocked) {
    updates[`players/${nextId}/movementMode`] = state.settings.movementMode || 'relative';
  }

  let logMsg;
  let announceCount = null;

  if (preAssign) {
    // Le joueur qui termine son tour reçoit dès maintenant ses déplacements
    // pour son PROCHAIN tour (au lieu d'attendre que ce soit à nouveau son tour).
    const leftover   = activePlayerBefore ? (activePlayerBefore.movesLeft || 0) : 0;
    const bonus      = randomMoves();
    const totalForActive = leftover + bonus;
    updates[`players/${activeId}/movesLeft`] = totalForActive;
    if (activeId === myId) announceCount = totalForActive;
    logMsg = `🔄 Tour ${newTurn} — ${state.players[nextId].name} joue`;
  } else {
    const bonusMoves   = randomMoves();
    const nextPlayer   = state.players[nextId];
    const currentMoves = nextPlayer ? (nextPlayer.movesLeft || 0) : 0;
    const totalMoves   = currentMoves + bonusMoves;
    updates[`players/${nextId}/movesLeft`] = totalMoves;
    logMsg = `🔄 Tour ${newTurn} — ${nextPlayer.name} joue (+${bonusMoves} déplacements, total: ${totalMoves})`;
  }

  await roomRef.update(updates);

  if (autoSkippedIds.length > 0) {
    const names = autoSkippedIds.map(id => (state.players[id] && state.players[id].name) || id).join(', ');
    await pushLog(`⏭ Passage automatique du tour pour : ${names}.`);
  }
  await pushLog(logMsg);

  if (announceCount !== null) {
    announceNextMoves(announceCount);
  }
}

// ============================================================
//  HÔTE : forcer le passage au joueur suivant en cas d'inactivité
//  (disponible uniquement quand aucun temps limite par tour n'est configuré,
//  puisque celui-ci gère déjà l'inactivité automatiquement).
// ============================================================
async function hostForceNextPlayer() {
  if (!isHost()) return;
  if (!gameState || gameState.status !== 'playing') return;
  if (getSetting('turnTimeLimit', 0) > 0) return;

  const activeId = gameState.currentPlayer;
  const activePlayer = activeId ? gameState.players[activeId] : null;
  if (!activeId || !activePlayer) return;

  await pushLog(`⏭ ${activePlayer.name} a été passé au joueur suivant par l'hôte (inactivité).`);
  await advanceTurn(gameState.objects, activeId);
}

// Coché : ce joueur est sauté automatiquement à chaque tour tant que la case
// reste cochée (contrairement à hostForceNextPlayer, qui ne saute qu'une
// fois, ponctuellement). Ses déplacements accumulés ne sont jamais touchés.
async function hostSetAutoSkip(playerId, checked) {
  if (!isHost() || !roomRef || !gameState) return;
  const p = gameState.players ? gameState.players[playerId] : null;
  await roomRef.update({ [`players/${playerId}/autoSkip`]: !!checked });
  await pushLog(`⏭ Passage automatique du tour ${checked ? 'activé' : 'désactivé'} pour ${p ? p.name : playerId}.`);
}

// ============================================================
//  MINUTEUR DE TOUR
// ============================================================
function startTurnTimer() {
  clearInterval(turnTimerInterval);
  const limit = getSetting('turnTimeLimit', 0);
  const timerEl = document.getElementById('turn-timer');
  if (!limit || limit <= 0) {
    if (timerEl) timerEl.style.display = 'none';
    return;
  }
  turnTimerDeadline = (gameState.turnStartedAt || Date.now()) + limit * 1000;
  lastBeepSecond = null;
  if (timerEl) timerEl.style.display = 'inline-block';
  turnTimerInterval = setInterval(tickTurnTimer, 250);
  tickTurnTimer();
}

function tickTurnTimer() {
  const timerEl = document.getElementById('turn-timer');
  const remainingMs = turnTimerDeadline - Date.now();
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  if (timerEl) timerEl.textContent = `⏱ ${remainingSec}s`;

  if (remainingSec <= 10 && remainingSec > 0 && remainingSec !== lastBeepSecond) {
    lastBeepSecond = remainingSec;
    playTickSound();
  }

  if (remainingMs <= 0) {
    clearInterval(turnTimerInterval);
    turnTimerInterval = null;
    autoSubmitTurn();
  }
}

function stopTurnTimer() {
  clearInterval(turnTimerInterval);
  turnTimerInterval = null;
  lastBeepSecond = null;
  const timerEl = document.getElementById('turn-timer');
  if (timerEl) timerEl.style.display = 'none';
}

function autoSubmitTurn() {
  if (!isMyTurn) return;
  addLocalLog('⏰ Temps écoulé, validation automatique de votre tour.');
  handleEndTurnClick();
}

// ============================================================
//  FIN DE PARTIE
// ============================================================
async function finishGame(winnerId) {
  const players = gameState.players;
  const scoresSnapshot = {};
  Object.values(players).forEach(p => {
    scoresSnapshot[p.name] = { score: p.score || 0, movesUsed: p.movesUsed || 0 };
  });

  const gameNumber = gameState.gameNumber || 1;
  const historyEntry = {
    gameNumber,
    winnerName: (players[winnerId] && players[winnerId].name) || '?',
    scores: scoresSnapshot,
    ts: Date.now()
  };

  const updates = {
    status:       'finished',
    winner:       winnerId,
    finishedAt:   Date.now(),
    rematchVotes: {}
  };
  updates[`history/${gameNumber}`] = historyEntry;

  await roomRef.update(updates);
}

// ============================================================
//  REVANCHE : gestion du modal de fin de partie
// ============================================================
function handleGameFinished() {
  const modal = document.getElementById('modal-win');
  modal.style.display = 'flex';
  renderFinishedModalContent();
  stopTurnTimer();

  if (gameState.status === 'finished') {
    clearInterval(rematchIntervalId);
    rematchIntervalId = setInterval(renderFinishedModalContent, 500);

    if (isHost() && rematchScheduledFor !== gameState.finishedAt) {
      rematchScheduledFor = gameState.finishedAt;
      const rejoinWindowMs = getSetting('rejoinWindowMs', DEFAULT_REJOIN_WINDOW_MS);
      const elapsed   = Date.now() - gameState.finishedAt;
      const remaining = Math.max(0, rejoinWindowMs - elapsed);
      const scheduledFor = gameState.finishedAt;

      setTimeout(() => {
        if (gameState.status === 'finished' && gameState.finishedAt === scheduledFor) {
          resolveRematch();
        }
      }, remaining);
    }
  } else {
    clearInterval(rematchIntervalId);
  }
}

function hideFinishedModal() {
  document.getElementById('modal-win').style.display = 'none';
  clearInterval(rematchIntervalId);
  rematchScheduledFor = null;
}

function renderFinishedModalContent() {
  if (!gameState) return;
  const winner       = gameState.players ? gameState.players[gameState.winner] : null;
  const titleEl      = document.getElementById('win-message');
  const historyEl    = document.getElementById('modal-history');
  const countdownEl  = document.getElementById('modal-countdown');
  const voteEl       = document.getElementById('modal-vote-buttons');
  const endedEl      = document.getElementById('modal-ended-actions');

  if (gameState.status === 'ended') {
    titleEl.textContent = winner
      ? `${winner.name} avait gagné avec ${winner.score} objets. Partie terminée.`
      : 'Partie terminée.';
    countdownEl.style.display = 'none';
    voteEl.style.display = 'none';
    endedEl.style.display = 'block';
  } else {
    titleEl.textContent = winner
      ? (gameState.winner === myId
          ? `🎉 Félicitations ${winner.name}, vous avez gagné avec ${winner.score} objets !`
          : `${winner.name} a gagné avec ${winner.score} objets !`)
      : '';

    const rejoinWindowMs = getSetting('rejoinWindowMs', DEFAULT_REJOIN_WINDOW_MS);
    const elapsed   = Date.now() - (gameState.finishedAt || Date.now());
    const remaining = Math.max(0, Math.ceil((rejoinWindowMs - elapsed) / 1000));
    countdownEl.textContent = `Retour à la salle d'attente dans ${remaining}s — votre choix sera visible des autres joueurs.`;
    countdownEl.style.display = 'block';

    const myVote = gameState.rematchVotes ? gameState.rematchVotes[myId] : undefined;
    voteEl.style.display = amSpectator ? 'none' : 'flex';
    voteEl.innerHTML = (myVote === undefined) ? `
      <button onclick="castRematchVote(true)">✅ Rester / rejouer</button>
      <button onclick="castRematchVote(false)">❌ Quitter la partie</button>
    ` : `<p>Vous avez choisi de "${myVote ? 'rester' : 'quitter'}". En attente de la fin du décompte...</p>`;
    endedEl.style.display = 'none';
  }

  const history = Object.values(gameState.history || {}).sort((a, b) => a.gameNumber - b.gameNumber);
  historyEl.innerHTML = history.map(h => {
    const scoresTxt = Object.entries(h.scores).map(([n, s]) => {
      const score = (typeof s === 'object') ? s.score : s;
      const moves = (typeof s === 'object') ? s.movesUsed : '?';
      return `${n} : ${score} objet(s) en ${moves} déplacement(s)`;
    }).join(' · ');
    return `<div class="history-entry">Partie ${h.gameNumber} — 🏆 ${h.winnerName}<br>${scoresTxt}</div>`;
  }).join('');
}

async function castRematchVote(vote) {
  await roomRef.child(`rematchVotes/${myId}`).set(vote);
}

// Après le décompte de fin de partie, retour systématique à la salle d'attente :
// chaque joueur y apparaît marqué "a accepté" ou "a quitté" selon son vote
// (l'absence de vote compte comme "a quitté"). C'est ensuite l'hôte qui décide
// quand relancer, depuis la salle d'attente (bouton "Démarrer la partie").
async function resolveRematch() {
  const votes = gameState.rematchVotes || {};
  const players = gameState.players || {};
  const rejoinStatus = {};
  Object.keys(players).forEach(id => {
    rejoinStatus[id] = (votes[id] === true) ? 'accepted' : 'left';
  });

  await roomRef.update({
    status:       'waiting',
    rejoinStatus: rejoinStatus,
    rematchVotes: {}
  });
  await pushLog("🕓 Retour à la salle d'attente pour la prochaine partie.");
}

// ============================================================
//  DESSIN DU PLATEAU
// ============================================================
function drawGrid() {
  if (!ctx || !gameState) return;

  const W = GRID_SIZE * CELL_SIZE;
  const H = GRID_SIZE * CELL_SIZE;

  // Fond
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(0, 0, W, H);

  // Grille
  ctx.strokeStyle = '#2a2a4a';
  ctx.lineWidth   = 1;
  for (let i = 0; i <= GRID_SIZE; i++) {
    ctx.beginPath();
    ctx.moveTo(i * CELL_SIZE, 0);
    ctx.lineTo(i * CELL_SIZE, H);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, i * CELL_SIZE);
    ctx.lineTo(W, i * CELL_SIZE);
    ctx.stroke();
  }

  // Pièges
  const traps = gameState.traps || {};
  Object.keys(traps).forEach(key => {
    const [tx, ty] = key.split('_').map(Number);
    const cx = tx * CELL_SIZE + CELL_SIZE / 2;
    const cy = ty * CELL_SIZE + CELL_SIZE / 2;
    ctx.font = `${CELL_SIZE * 0.4}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('❌', cx, cy);
  });

  // Objets (aperçu local en mode différé, seulement si le pion fantôme est activé)
  const objects = (previewOverride && showGhostPreview && previewOverride.objects)
    ? previewOverride.objects
    : (gameState.objects || {});
  Object.values(objects).forEach(obj => {
    const cx = obj.x * CELL_SIZE + CELL_SIZE / 2;
    const cy = obj.y * CELL_SIZE + CELL_SIZE / 2;
    ctx.fillStyle = '#FF9800';
    ctx.beginPath();
    ctx.arc(cx, cy, CELL_SIZE * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `${CELL_SIZE * 0.35}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⭐', cx, cy);
  });

  // Joueurs
  const players = gameState.players || {};
  Object.entries(players).forEach(([id, p]) => {
    const isMe = (id === myId);
    const useGhost = isMe && previewOverride && showGhostPreview;

    const displayX   = useGhost ? previewOverride.x : p.x;
    const displayY   = useGhost ? previewOverride.y : p.y;
    const displayDir = useGhost ? previewOverride.direction : p.direction;

    const cx   = displayX * CELL_SIZE + CELL_SIZE / 2;
    const cy   = displayY * CELL_SIZE + CELL_SIZE / 2;
    const color = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length];

    // Halo si c'est le joueur actif
    if (id === gameState.currentPlayer) {
      ctx.fillStyle = color + '44';
      ctx.beginPath();
      ctx.arc(cx, cy, CELL_SIZE * 0.48, 0, Math.PI * 2);
      ctx.fill();
    }

    // Corps du joueur
    ctx.fillStyle = p.online === false ? color + '66' : color;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL_SIZE * 0.32, 0, Math.PI * 2);
    ctx.fill();

    // Bordure (moi = épaisse, pointillée si aperçu prévisionnel)
    ctx.strokeStyle = isMe ? '#fff' : '#000';
    ctx.lineWidth   = isMe ? 2.5 : 1;
    if (useGhost && commandQueue.length > 0) {
      ctx.setLineDash([4, 3]);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Flèche de direction (masquée en mode absolu — propre à chaque joueur)
    if (effectiveMovementMode(p) !== 'absolute') {
      drawDirectionArrow(ctx, cx, cy, displayDir, color);
    }

    // Initiale du joueur
    ctx.fillStyle    = '#fff';
    ctx.font         = `bold ${CELL_SIZE * 0.28}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(p.name[0].toUpperCase(), cx, cy);
  });

  // Coordonnées (optionnel)
  ctx.fillStyle    = '#333';
  ctx.font         = '9px sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i < GRID_SIZE; i++) {
    ctx.fillText(i, i * CELL_SIZE + CELL_SIZE / 2, 2);
  }
}

function drawDirectionArrow(ctx, cx, cy, dir, color) {
  const size  = CELL_SIZE * 0.18;
  const dist  = CELL_SIZE * 0.38;
  const angles = { N: -Math.PI/2, E: 0, S: Math.PI/2, W: Math.PI };
  const angle  = angles[dir];

  const ax = cx + Math.cos(angle) * dist;
  const ay = cy + Math.sin(angle) * dist;

  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(angle);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.6, -size * 0.6);
  ctx.lineTo(-size * 0.6,  size * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ============================================================
//  PANNEAU DE L'HÔTE — réglages en direct + suivi d'activité des joueurs
// ============================================================
const HOST_SETTING_LABELS = {
  modeLocked:     'verrouillage du mode de déplacement',
  movementMode:   'mode de déplacement imposé',
  gameModePolicy: "politique d'interaction (direct/différé)",
  ghostAllowed:   'aperçu fantôme autorisé',
  turnTimeLimit:  'temps limite par tour',
  rejoinWindowMs: 'durée pour rejoindre une nouvelle partie'
};

async function hostUpdateSetting(key, value) {
  if (!isHost()) return;
  await roomRef.update({ [`settings/${key}`]: value });
  await pushLog(`⚙️ L'hôte a modifié : ${HOST_SETTING_LABELS[key] || key}.`);
}

function toggleHostPanel() {
  const body = document.getElementById('host-panel-body');
  const btn  = document.getElementById('btn-toggle-host-panel');
  if (!body || !btn) return;
  const show = body.style.display === 'none';
  body.style.display = show ? 'block' : 'none';
  btn.textContent = show ? 'Masquer' : 'Afficher';
}

// N'écrase la valeur d'un champ que si l'hôte n'est pas en train de le modifier
// (évite de couper l'utilisateur en pleine saisie lors d'un rafraîchissement).
function setIfNotFocused(id, value, prop) {
  const el = document.getElementById(id);
  if (!el || document.activeElement === el) return;
  if (prop) el[prop] = value; else el.value = value;
}

function renderHostPanel() {
  const panel = document.getElementById('host-panel');
  if (!panel) return;

  if (!isHost() || !gameState || gameState.status !== 'playing') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';

  const settings = gameState.settings || {};
  setIfNotFocused('host-mode-locked', !!settings.modeLocked, 'checked');
  const lockedRow = document.getElementById('host-locked-mode-row');
  if (lockedRow) lockedRow.style.display = settings.modeLocked ? 'block' : 'none';
  setIfNotFocused('host-movement-mode', settings.movementMode || 'relative');
  setIfNotFocused('host-game-mode-policy', settings.gameModePolicy || 'free');
  setIfNotFocused('host-ghost-allowed', settings.ghostAllowed !== false, 'checked');
  setIfNotFocused('host-turn-time-limit', settings.turnTimeLimit || 0);
  setIfNotFocused('host-rejoin-window', Math.round((settings.rejoinWindowMs || DEFAULT_REJOIN_WINDOW_MS) / 1000));

  renderHostActivityList();
}

function formatDuration(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderHostActivityList() {
  const list = document.getElementById('host-activity-list');
  const hint = document.getElementById('host-skip-hint');
  if (!list || !gameState) return;

  const players  = gameState.players || {};
  const activeId = gameState.currentPlayer;
  const now      = Date.now();
  const turnStartedAt = gameState.turnStartedAt || now;
  const noTimeLimit = !(gameState.settings && gameState.settings.turnTimeLimit > 0);

  list.innerHTML = Object.entries(players).map(([id, p]) => {
    const isActive  = id === activeId;
    const totalMs   = (p.totalActiveMs || 0) + (isActive ? (now - turnStartedAt) : 0);
    const turnTxt   = isActive ? `🎯 tour en cours : ${formatDuration(now - turnStartedAt)}` : '';
    const skipBtn   = (isActive && noTimeLimit)
      ? `<button class="small-btn" onclick="hostForceNextPlayer()" title="Forcer le passage au joueur suivant (ponctuel)">⏭ Suivant</button>`
      : '';
    // L'id du joueur est toujours un identifiant "player_slug" (voir
    // slugifyName) : sûr à interpoler tel quel dans un attribut HTML.
    return `<div class="activity-row${isActive ? ' activity-active' : ''}">
      <span>${isActive ? '🎮 ' : ''}${p.name}</span>
      <span>⏱ total ${formatDuration(totalMs)}</span>
      <span>${turnTxt}</span>
      <label class="auto-skip-toggle" title="Passer automatiquement ce joueur à chaque tour">
        <input type="checkbox" class="auto-skip-checkbox" data-player-id="${id}"${p.autoSkip ? ' checked' : ''}> auto
      </label>
      ${skipBtn}
    </div>`;
  }).join('');

  if (hint) hint.style.display = noTimeLimit ? 'block' : 'none';
}

// Barre rapide toujours visible pour l'hôte (au-dessus du plateau), pour ne pas
// avoir à ouvrir le panneau replié pour voir le temps ou passer au joueur suivant.
function renderHostQuickBar() {
  const bar = document.getElementById('host-quick-bar');
  if (!bar) return;

  if (!isHost() || !gameState || gameState.status !== 'playing') {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';

  const activeId = gameState.currentPlayer;
  const activePlayer = activeId ? gameState.players[activeId] : null;
  const turnStartedAt = gameState.turnStartedAt || Date.now();
  const elapsed = Date.now() - turnStartedAt;

  const timerEl = document.getElementById('host-quick-turn-timer');
  if (timerEl) {
    timerEl.textContent = activePlayer
      ? `⏱ ${activePlayer.name} joue depuis ${formatDuration(elapsed)}`
      : '⏱ -';
  }

  const noTimeLimit = !(gameState.settings && gameState.settings.turnTimeLimit > 0);
  const skipBtn = document.getElementById('host-quick-skip-btn');
  if (skipBtn) skipBtn.style.display = noTimeLimit ? 'inline-block' : 'none';

  const autoSkipCb = document.getElementById('host-quick-autoskip-checkbox');
  if (autoSkipCb && document.activeElement !== autoSkipCb) {
    autoSkipCb.checked = !!(activePlayer && activePlayer.autoSkip);
  }
}

// Coche/décoche "Passer auto" pour le joueur actuellement actif, depuis la
// barre rapide (raccourci vers hostSetAutoSkip, sans ouvrir le panneau).
function hostQuickAutoSkipChanged(checked) {
  if (!gameState || !gameState.currentPlayer) return;
  hostSetAutoSkip(gameState.currentPlayer, checked);
}

// ============================================================
//  MISE À JOUR DE L'INTERFACE
// ============================================================
function updateUI() {
  if (!gameState) return;

  const players = gameState.players || {};
  const myPlayer = players[myId];

  updatePlayersBar();
  updateControlPad();
  syncMovementModeSelect();
  applyGameModePolicy();
  renderHostPanel();
  renderHostQuickBar();
  renderChat();

  document.getElementById('win-score-display').textContent = currentWinScore();

  // Scores (panneau gauche)
  const scoresList = document.getElementById('scores-list');
  scoresList.innerHTML = '';
  Object.entries(players)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0))
    .forEach(([id, p]) => {
      const div  = document.createElement('div');
      div.className = 'score-entry' + (id === gameState.currentPlayer ? ' active-player' : '');
      const color = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length];
      div.innerHTML = `
        <span style="color:${color}">${id === myId ? '👤' : '🔵'} ${p.name}${p.online === false ? ' 💤' : ''}</span>
        <span>${p.score || 0}/${currentWinScore()}</span>
      `;
      scoresList.appendChild(div);
    });

  // Infos de tour
  const currentPlayer = players[gameState.currentPlayer];
  document.getElementById('current-player-name').textContent =
    currentPlayer ? currentPlayer.name : '-';
  document.getElementById('moves-left').textContent =
    isMyTurn ? (myPlayer?.movesLeft || 0) : '-';
  document.getElementById('my-score').textContent =
    myPlayer?.score || 0;

  // Activer/désactiver les contrôles
  const btns = document.querySelectorAll('.ctrl-btn:not(.empty), #btn-end-turn, .pickup-btn');
  btns.forEach(b => {
    b.disabled = !isMyTurn;
    b.style.opacity = isMyTurn ? '1' : '0.4';
  });

  // Message d'attente (ce n'est pas mon tour)
  document.getElementById('waiting-msg').style.display =
    isMyTurn ? 'none' : 'block';

  updateLog();
}

// ============================================================
//  BARRE DES JOUEURS (en haut de l'écran, centrée)
// ============================================================
function updatePlayersBar() {
  const bar = document.getElementById('players-bar');
  if (!bar) return;
  const players = gameState.players || {};

  bar.innerHTML = Object.entries(players).map(([id, p]) => {
    const color    = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length];
    const isActive = id === gameState.currentPlayer;
    const isMe     = id === myId;
    const isOffline = p.online === false;
    return `
      <div class="player-chip${isActive ? ' active-chip' : ''}${isMe ? ' me-chip' : ''}${isOffline ? ' offline-chip' : ''}">
        ${isActive ? '<div class="gamepad-icon">🎮</div>' : ''}
        <div class="chip-avatar" style="background:${color}">${p.name[0].toUpperCase()}</div>
        <div>
          <div class="chip-name">${p.name}${isMe ? ' (vous)' : ''}${isOffline ? ' 💤' : ''}${p.autoSkip ? ' ⏭' : ''}</div>
          <div class="chip-stats">⭐ ${p.score || 0} · 👣 ${p.movesLeft || 0}</div>
        </div>
      </div>`;
  }).join('');
}

// ============================================================
//  JOURNAL (optionnel, replié par défaut)
// ============================================================
function toggleLog() {
  journalVisible = !journalVisible;
  document.getElementById('log-list').style.display = journalVisible ? 'block' : 'none';
  document.getElementById('btn-toggle-log').textContent = journalVisible ? 'Masquer' : 'Afficher';
}

function updateLog() {
  const logData = gameState.log || {};
  const entries = Object.values(logData)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, 20);

  const logList = document.getElementById('log-list');
  logList.innerHTML = entries
    .map(e => `<div class="log-entry">${e.msg}</div>`)
    .join('');
}

// ============================================================
//  CHAT DE LA SALLE (visible de tous, joueurs et spectateurs)
//  Stocké dans rooms/{code}/chat, synchronisé via le même listener que
//  le reste de l'état de la salle — pas besoin d'un canal séparé.
// ============================================================
async function sendChatMessage() {
  const input = document.getElementById('chat-input');
  if (!input || !roomRef) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  const senderName = amSpectator ? (myName || '👁 Spectateur') : (myName || '?');
  await roomRef.child('chat').push({
    senderName,
    senderSessionId: mySessionId,
    msg:  text.slice(0, 200),
    ts:   Date.now(),
    isSpectator: !!amSpectator
  });
}

function renderChat() {
  if (!gameState) return;
  const chatData = gameState.chat || {};
  const entries = Object.values(chatData).sort((a, b) => (a.ts || 0) - (b.ts || 0));

  if (chatLastSeenTs === null) {
    // Premier rendu après connexion : pas d'alerte rétroactive sur l'historique existant.
    chatLastSeenTs = entries.length ? entries[entries.length - 1].ts : 0;
  } else {
    const newOnes = entries.filter(e => e.ts > chatLastSeenTs && e.senderSessionId !== mySessionId);
    if (newOnes.length > 0) notifyNewChatMessages(newOnes.length);
    if (entries.length) chatLastSeenTs = Math.max(chatLastSeenTs, entries[entries.length - 1].ts);
  }

  const list = document.getElementById('chat-messages');
  if (list) {
    list.innerHTML = entries.slice(-50).map(e => {
      const who = e.isSpectator ? `👁 ${e.senderName}` : e.senderName;
      return `<div class="chat-msg"><span class="chat-msg-name">${escapeHtml(who)}</span>${escapeHtml(e.msg)}</div>`;
    }).join('');
    list.scrollTop = list.scrollHeight;
  }
}

function notifyNewChatMessages(count) {
  playChatSound();

  const panel = document.getElementById('chat-panel');
  if (panel) {
    panel.classList.add('chat-flash');
    clearTimeout(chatFlashTimeoutId);
    chatFlashTimeoutId = setTimeout(() => panel.classList.remove('chat-flash'), 1600);
  }

  chatUnreadCount += count;
  updateChatBadge();
}

function updateChatBadge() {
  const badge = document.getElementById('chat-unread-badge');
  if (!badge) return;
  if (chatUnreadCount > 0) {
    badge.textContent = String(chatUnreadCount);
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function markChatRead() {
  chatUnreadCount = 0;
  updateChatBadge();
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
//  SIGNAUX SONORES ET VISUELS
// ============================================================
function playTurnSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
  } catch (e) {
    // Lecture audio bloquée (politique du navigateur) : on ignore silencieusement
  }
}

function playTickSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const osc  = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.frequency.value = 1200;
    gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.15);
  } catch (e) { /* ignore */ }
}

// Petit "ding-dong" à deux notes, volontairement distinct des bips de tour,
// pour signaler un nouveau message de chat.
function playChatSound() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const beep = (freq, delay) => {
      setTimeout(() => {
        try {
          const osc  = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.12, audioCtx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2);
          osc.start();
          osc.stop(audioCtx.currentTime + 0.2);
        } catch (e) { /* ignore */ }
      }, delay);
    };
    beep(660, 0);
    beep(880, 120);
  } catch (e) { /* lecture audio bloquée : on ignore silencieusement */ }
}

function flashTurnAlert() {
  const banner = document.getElementById('turn-alert-banner');
  if (!banner) return;
  banner.classList.add('show');
  clearTimeout(flashTimeoutId);
  flashTimeoutId = setTimeout(() => banner.classList.remove('show'), 2500);
}

function announceNextMoves(count) {
  const banner = document.getElementById('next-turn-info-banner');
  if (!banner) {
    addLocalLog(`ℹ️ Sauf victoire d'un autre joueur, vous disposerez de ${count} déplacements au prochain tour.`);
    return;
  }
  banner.textContent = `ℹ️ Sauf victoire d'un autre joueur, vous disposerez de ${count} déplacements au prochain tour.`;
  banner.classList.add('show');
  clearTimeout(nextTurnBannerTimeout);
  nextTurnBannerTimeout = setTimeout(() => banner.classList.remove('show'), 4500);
}

// ============================================================
//  UTILITAIRES
// ============================================================
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

async function pushLog(msg) {
  await roomRef.child('log').push({ msg, ts: Date.now() });
}

function addLocalLog(msg) {
  const logList = document.getElementById('log-list');
  if (!logList) return;
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.style.color = '#e94560';
  div.textContent = msg;
  logList.prepend(div);
}

// ============================================================
//  RACCOURCI CLAVIER : Retour arrière / Suppr = effacer la dernière commande
// ============================================================
window.addEventListener('keydown', (e) => {
  if (gameMode === 'deferred' && isMyTurn && (e.key === 'Backspace' || e.key === 'Delete')) {
    e.preventDefault();
    undoLastCommand();
  }
});
