// ============================================================
//  CONFIGURATION FIREBASE  ← REMPLACEZ PAR VOS VALEURS
// ============================================================
const firebaseConfig = {
  apiKey: "VOTRE_API_KEY",
  authDomain: "VOTRE_PROJECT.firebaseapp.com",
  databaseURL: "https://VOTRE_PROJECT-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "VOTRE_PROJECT",
  storageBucket: "VOTRE_PROJECT.appspot.com",
  messagingSenderId: "VOTRE_SENDER_ID",
  appId: "VOTRE_APP_ID"
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
const REMATCH_DELAY_MS = 15000; // durée de vote pour la revanche

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
let gameState  = null;   // copie locale du state Firebase
let isMyTurn   = false;
let canvas, ctx;

// ── Mode différé ──
let gameMode         = 'direct';  // 'direct' | 'deferred'
let commandQueue      = [];        // actions en attente (mode différé)
let previewOverride   = null;      // aperçu local {x,y,direction,objects}
let showGhostPreview  = false;     // affichage du pion fantôme (désactivé par défaut)

// ── Journal ──
let journalVisible = false;

// ── Son / alerte de tour ──
let audioCtx = null;
let flashTimeoutId = null;

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

// Pré-remplir le code de salle et/ou le pseudo depuis l'URL (?room=XXXX&name=YYY)
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  const nameParam  = params.get('name');
  if (roomParam) document.getElementById('room-code').value = roomParam.toUpperCase();
  if (nameParam)  document.getElementById('player-name').value = nameParam;
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

// ============================================================
//  RÉGLAGES AVANCÉS (écran de connexion)
// ============================================================
function toggleAdvancedSettings() {
  const el = document.getElementById('advanced-settings');
  el.style.display = (el.style.display === 'none') ? 'block' : 'none';
}

// ============================================================
//  ÉCRAN DE CONNEXION → REJOINDRE / CRÉER UNE PARTIE
// ============================================================
async function proceedFromLogin() {
  myName   = document.getElementById('player-name').value.trim();
  roomCode = document.getElementById('room-code').value.trim().toUpperCase();
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  if (!myName)   { errEl.textContent = 'Entrez votre pseudo.';       return; }
  if (!roomCode) { errEl.textContent = 'Entrez un code de partie.';  return; }

  const checkRef = db.ref('rooms/' + roomCode);
  const snap = await checkRef.once('value');

  if (snap.exists()) {
    const state = snap.val();
    const candidateId = playerIdFor(myName);
    const existingPlayer = (state.players || {})[candidateId];

    if (existingPlayer && existingPlayer.online === true) {
      errEl.textContent = "Ce joueur est déjà dans la salle (fermez l'autre onglet ou choisissez un autre pseudo).";
      return;
    }
    if (state.status !== 'waiting' && !existingPlayer) {
      errEl.textContent = 'Cette partie a déjà commencé. Seuls les joueurs déjà inscrits peuvent la rejoindre.';
      return;
    }
    await joinExistingRoom(state, candidateId, existingPlayer);
  } else {
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

  const errEl = document.getElementById('login-error');
  const candidateId = playerIdFor(myName);

  myId    = candidateId;
  roomRef = db.ref('rooms/' + roomCode);

  const settings = {
    movementMode, modeLocked, hostId: myId, expectedPlayers,
    gameModePolicy, ghostAllowed,
    minMoves, maxMoves, winScore, initObjects, turnTimeLimit,
    trapsEnabled, trapCount
  };

  const initialState = createInitialState(settings);
  initialState.players[myId] = createPlayer(myName, 0);

  await roomRef.set(initialState);
  await pushLog(`Partie créée par ${myName}`);

  setupPresence();
  enterGameScreen();
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
    await roomRef.child('players/' + myId).set(createPlayer(myName, colorIndex));
    await pushLog(`${myName} a rejoint la partie`);
  }

  setupPresence();
  enterGameScreen();
}

function setupPresence() {
  const myOnlineRef = roomRef.child('players/' + myId + '/online');
  const connectedRef = db.ref('.info/connected');
  connectedRef.on('value', (snap) => {
    if (snap.val() === true) {
      myOnlineRef.onDisconnect().set(false);
      myOnlineRef.set(true);
    }
  });
}

function enterGameScreen() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('display-room').textContent   = roomCode;
  document.getElementById('display-player').textContent = myName;

  canvas = document.getElementById('game-canvas');
  ctx    = canvas.getContext('2d');

  roomRef.on('value', onStateUpdate);
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
async function copyInviteLink() {
  const feedback = document.getElementById('invite-link-feedback');
  try {
    await navigator.clipboard.writeText(getInviteLink());
    if (feedback) { feedback.textContent = '✅ Lien copié !'; setTimeout(() => feedback.textContent = '', 2500); }
  } catch (e) { window.prompt('Copiez ce lien :', getInviteLink()); }
}
async function copyPersonalLink() {
  const feedback = document.getElementById('invite-link-feedback');
  try {
    await navigator.clipboard.writeText(getPersonalLink());
    if (feedback) { feedback.textContent = '✅ Lien personnel copié !'; setTimeout(() => feedback.textContent = '', 2500); }
    else { addLocalLog('🔗 Lien personnel copié !'); }
  } catch (e) { window.prompt('Copiez ce lien :', getPersonalLink()); }
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
    rematchVotes:  {}
  };
}

function createPlayer(name, colorIndex) {
  return {
    name:       name,
    colorIndex: colorIndex,
    x:          Math.floor(Math.random() * GRID_SIZE),
    y:          Math.floor(Math.random() * GRID_SIZE),
    direction:  DIRECTIONS[Math.floor(Math.random() * 4)],
    score:      0,
    movesLeft:  0,
    movesUsed:  0,
    online:     true
  };
}

// ============================================================
//  GÉNÉRATION D'OBJETS ET DE PIÈGES
// ============================================================
function generateObjects(count, existingObjects) {
  const objects = { ...existingObjects };
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < 500) {
    attempts++;
    const x = Math.floor(Math.random() * GRID_SIZE);
    const y = Math.floor(Math.random() * GRID_SIZE);
    const key = `${x}_${y}`;
    if (!objects[key]) {
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
  }

  if (gameState.status === 'finished' || gameState.status === 'ended') {
    handleGameFinished();
  } else {
    hideFinishedModal();
  }
}

function isHost() {
  return !!gameState && gameState.settings && gameState.settings.hostId === myId;
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
  const personalInput = document.getElementById('lobby-personal-link');
  if (personalInput) personalInput.value = getPersonalLink();

  const players = gameState.players || {};
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = Object.values(players).map(p =>
    `<li class="${p.online === false ? 'offline-item' : ''}">${p.name}${p.online === false ? ' (hors ligne)' : ''}</li>`
  ).join('');

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
  const ids = Object.keys(gameState.players || {});
  if (ids.length === 0) return;

  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  const firstId  = shuffled[0];
  const movesForFirst = randomMoves();

  const updates = {
    status:        'playing',
    turn:          1,
    currentPlayer: firstId,
    playerOrder:   shuffled,
    turnStartedAt: Date.now()
  };
  updates[`players/${firstId}/movesLeft`] = movesForFirst;

  await roomRef.update(updates);
  await pushLog(`Tour 1 — ${gameState.players[firstId].name} joue (${movesForFirst} déplacements)`);
}

// ============================================================
//  MODE DE DÉPLACEMENT (relatif / absolu)
// ============================================================
async function changeMovementMode(mode) {
  const settings = gameState.settings || {};
  const allowed = isHost() || !settings.modeLocked;
  if (!allowed) {
    document.getElementById('movement-mode-select').value = settings.movementMode;
    addLocalLog("🔒 Le mode de déplacement est verrouillé par l'hôte.");
    return;
  }
  await roomRef.update({ 'settings/movementMode': mode });
}

function syncMovementModeSelect() {
  const sel = document.getElementById('movement-mode-select');
  if (!sel) return;
  const settings = gameState.settings || {};
  sel.value = settings.movementMode || 'relative';
  sel.disabled = !(isHost() || !settings.modeLocked);
}

function updateControlPad() {
  const mode = (gameState.settings && gameState.settings.movementMode) || 'relative';
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

function applyGameModePolicy() {
  const policy = (gameState.settings && gameState.settings.gameModePolicy) || 'free';
  const modeSwitch = document.getElementById('mode-switch');

  if (policy === 'forceDirect') {
    if (gameMode !== 'direct') setGameModeLocal('direct');
    if (modeSwitch) modeSwitch.style.display = 'none';
  } else if (policy === 'forceDeferred') {
    if (gameMode !== 'deferred') setGameModeLocal('deferred');
    if (modeSwitch) modeSwitch.style.display = 'none';
  } else {
    if (modeSwitch) modeSwitch.style.display = 'flex';
  }

  const ghostAllowed = gameState.settings ? gameState.settings.ghostAllowed !== false : true;
  const ghostToggle = document.getElementById('ghost-toggle');
  if (!ghostAllowed) {
    showGhostPreview = false;
    const cb = document.getElementById('ghost-checkbox');
    if (cb) cb.checked = false;
    if (ghostToggle) ghostToggle.style.display = 'none';
  } else if (ghostToggle) {
    ghostToggle.style.display = (gameMode === 'deferred') ? 'block' : 'none';
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
      const newScore = (player.score || 0) + 1;
      const updates  = { [`players/${myId}/score`]: newScore };
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

  const logMsg = state.trapped
    ? `💥 ${player.name} tombe dans un piège et reste bloqué ! Fin de son tour.`
    : describeAction(action, player.name, state.direction);

  await roomRef.update({
    [`players/${myId}/x`]:         state.x,
    [`players/${myId}/y`]:         state.y,
    [`players/${myId}/direction`]: state.direction,
    [`players/${myId}/movesLeft`]: state.movesLeft,
    [`players/${myId}/movesUsed`]: (player.movesUsed || 0) + 1
  });
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
    await pushLog(`💥 ${player.name} tombe dans un piège pendant l'exécution de son tour ! Déplacements restants annulés.`);
  } else if (commandQueue.length > 0) {
    await pushLog(`📝 ${player.name} exécute ${commandQueue.length} commande(s) (mode différé)`);
  }
  if (pickedKeys.length > 0) {
    await pushLog(`⭐ ${player.name} ramasse ${pickedKeys.length} objet(s) ! Score : ${finalState.score}`);
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
async function advanceTurn(objectsSnapshot) {
  const state       = gameState;
  const playerOrder = state.playerOrder || Object.keys(state.players);
  const currentIdx  = playerOrder.indexOf(myId);
  const nextIdx     = (currentIdx + 1) % playerOrder.length;
  const nextId      = playerOrder[nextIdx];

  const currentObjectsCount = Object.keys(objectsSnapshot || {}).length;
  const missing             = currentInitObjects() - currentObjectsCount;
  let newObjects            = { ...objectsSnapshot };
  if (missing > 0) {
    newObjects = generateObjects(missing, newObjects);
  }

  const bonusMoves    = randomMoves();
  const nextPlayer    = state.players[nextId];
  const currentMoves  = nextPlayer ? (nextPlayer.movesLeft || 0) : 0;
  const totalMoves    = currentMoves + bonusMoves;
  const newTurn       = nextIdx === 0 ? (state.turn || 1) + 1 : (state.turn || 1);

  const updates = {
    currentPlayer:                    nextId,
    turn:                             newTurn,
    objects:                          newObjects,
    turnStartedAt:                    Date.now(),
    [`players/${nextId}/movesLeft`]: totalMoves
  };

  await roomRef.update(updates);
  await pushLog(`🔄 Tour ${newTurn} — ${nextPlayer.name} joue (+${bonusMoves} déplacements, total: ${totalMoves})`);
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
      const elapsed   = Date.now() - gameState.finishedAt;
      const remaining = Math.max(0, REMATCH_DELAY_MS - elapsed);
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

    const elapsed   = Date.now() - (gameState.finishedAt || Date.now());
    const remaining = Math.max(0, Math.ceil((REMATCH_DELAY_MS - elapsed) / 1000));
    const totalPlayers = Object.keys(gameState.players || {}).length;
    const threshold = Math.min(2, totalPlayers);
    const thresholdTxt = threshold <= 1 ? 'vous votez "Oui"' : `${threshold} joueurs ou plus votent "Oui"`;
    countdownEl.textContent = `Nouvelle partie possible encore ${remaining}s si ${thresholdTxt}.`;
    countdownEl.style.display = 'block';

    const myVote = gameState.rematchVotes ? gameState.rematchVotes[myId] : undefined;
    voteEl.style.display = 'flex';
    voteEl.innerHTML = (myVote === undefined) ? `
      <button onclick="castRematchVote(true)">✅ Oui, rejouer</button>
      <button onclick="castRematchVote(false)">❌ Non merci</button>
    ` : `<p>Vous avez voté "${myVote ? 'Oui' : 'Non'}". En attente des autres joueurs...</p>`;
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

async function resolveRematch() {
  const votes = gameState.rematchVotes || {};
  const yesCount = Object.values(votes).filter(v => v === true).length;
  const totalPlayers = Object.keys(gameState.players || {}).length;
  const threshold = Math.min(2, totalPlayers); // 1 joueur seul → 1 "oui" suffit

  if (yesCount >= threshold) {
    await startNewRound();
  } else {
    await roomRef.update({ status: 'ended' });
  }
}

async function startNewRound() {
  const players = gameState.players;
  const ids = Object.keys(players);

  const shuffled = [...ids].sort(() => Math.random() - 0.5);
  const firstId  = shuffled[0];
  const movesForFirst = randomMoves();

  const resetPlayers = {};
  ids.forEach(id => {
    resetPlayers[id] = {
      ...players[id],
      x:         Math.floor(Math.random() * GRID_SIZE),
      y:         Math.floor(Math.random() * GRID_SIZE),
      direction: DIRECTIONS[Math.floor(Math.random() * 4)],
      score:     0,
      movesUsed: 0,
      movesLeft: (id === firstId) ? movesForFirst : 0
    };
  });

  const gameNumber = (gameState.gameNumber || 1) + 1;
  const newObjects = generateObjects(currentInitObjects(), {});
  const trapsEnabled = getSetting('trapsEnabled', false);
  const trapCount     = getSetting('trapCount', DEFAULT_TRAP_COUNT);
  const newTraps    = trapsEnabled ? generateTraps(trapCount, newObjects) : {};

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
    gameNumber:    gameNumber,
    turnStartedAt: Date.now()
  };

  await roomRef.update(updates);
  await pushLog(`🔁 Nouvelle partie (partie n°${gameNumber}) — ${resetPlayers[firstId].name} commence`);
}

// ============================================================
//  DESSIN DU PLATEAU
// ============================================================
function drawGrid() {
  if (!ctx || !gameState) return;

  const W = GRID_SIZE * CELL_SIZE;
  const H = GRID_SIZE * CELL_SIZE;
  const movementMode = (gameState.settings && gameState.settings.movementMode) || 'relative';

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

    // Flèche de direction (masquée en mode absolu)
    if (movementMode !== 'absolute') {
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
          <div class="chip-name">${p.name}${isMe ? ' (vous)' : ''}${isOffline ? ' 💤' : ''}</div>
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

function flashTurnAlert() {
  const banner = document.getElementById('turn-alert-banner');
  if (!banner) return;
  banner.classList.add('show');
  clearTimeout(flashTimeoutId);
  flashTimeoutId = setTimeout(() => banner.classList.remove('show'), 2500);
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
