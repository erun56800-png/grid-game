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
const WIN_SCORE         = 20;   // objets pour gagner
const INIT_OBJECTS     = 15;   // objets au démarrage
const DIRECTIONS       = ['N', 'E', 'S', 'W'];
const DIR_VECTORS      = { N:[0,-1], E:[1,0], S:[0,1], W:[-1,0] };
const REMATCH_DELAY_MS = 15000; // durée de vote pour la revanche

// Couleurs joueurs
const PLAYER_COLORS  = ['#4CAF50','#2196F3','#FF5722','#9C27B0',
                         '#00BCD4','#FF9800','#E91E63','#8BC34A'];

// Libellés affichés dans la file de commandes (mode différé)
const ACTION_LABELS = {
  forward:   '⬆ Avancer',
  backward:  '⬇ Reculer',
  turnLeft:  '↺ Pivoter gauche',
  turnRight: '↻ Pivoter droite',
  pickup:    '📦 Ramasser',
  moveN:     '⬆ Nord',
  moveE:     '➡ Est',
  moveS:     '⬇ Sud',
  moveW:     '⬅ Ouest'
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

// ============================================================
//  INITIALISATION FIREBASE
// ============================================================
firebase.initializeApp(firebaseConfig);
db = firebase.database();

// Pré-remplir le code de salle si présent dans l'URL (?room=XXXX)
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    document.getElementById('room-code').value = roomParam.toUpperCase();
  }
});

// ============================================================
//  UTILITAIRE : identifiant unique de joueur
// ============================================================
function generateId() {
  return 'player_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
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
    if (state.status !== 'waiting') {
      errEl.textContent = 'Cette partie a déjà commencé ou est terminée.';
      return;
    }
    await joinExistingRoom(state);
  } else {
    // Nouvelle salle : afficher les réglages hôte avant de créer
    document.getElementById('host-settings').style.display = 'block';
    document.getElementById('btn-join').style.display = 'none';
  }
}

async function createRoomWithSettings() {
  const movementMode    = document.querySelector('input[name="movement-mode"]:checked').value;
  const modeLocked      = document.getElementById('lock-mode-checkbox').checked;
  const expectedPlayers = Math.max(1, parseInt(document.getElementById('expected-players').value) || 2);

  myId    = generateId();
  roomRef = db.ref('rooms/' + roomCode);

  const initialState = createInitialState({
    movementMode,
    modeLocked,
    hostId: myId,
    expectedPlayers
  });
  initialState.players[myId] = createPlayer(myName, 0);

  await roomRef.set(initialState);
  await pushLog(`Partie créée par ${myName}`);

  enterGameScreen();
}

async function joinExistingRoom(state) {
  myId    = generateId();
  roomRef = db.ref('rooms/' + roomCode);

  const playerCount = Object.keys(state.players || {}).length;
  const colorIndex  = playerCount % PLAYER_COLORS.length;
  await roomRef.child('players/' + myId).set(createPlayer(myName, colorIndex));
  await pushLog(`${myName} a rejoint la partie`);

  enterGameScreen();
}

function enterGameScreen() {
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('display-room').textContent   = roomCode;
  document.getElementById('display-player').textContent = myName;

  canvas = document.getElementById('game-canvas');
  ctx    = canvas.getContext('2d');

  roomRef.on('value', onStateUpdate);

  window.addEventListener('beforeunload', () => {
    roomRef.child('players/' + myId).remove();
  });
}

// ============================================================
//  CRÉATION D'ÉTAT INITIAL
// ============================================================
function createInitialState(settings) {
  const objects = generateObjects(INIT_OBJECTS, {});
  return {
    status:        'waiting',   // waiting | playing | finished | ended
    turn:          0,
    currentPlayer: null,
    playerOrder:   [],
    players:       {},
    objects:       objects,
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
    online:     true
  };
}

// ============================================================
//  GÉNÉRATION D'OBJETS
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

// ============================================================
//  MISE À JOUR DE L'ÉTAT (listener Firebase)
// ============================================================
function onStateUpdate(snap) {
  if (!snap.exists()) return;
  gameState = snap.val();

  // Garantir les structures
  if (!gameState.players)      gameState.players      = {};
  if (!gameState.objects)      gameState.objects      = {};
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
  }

  updateUI();
  drawGrid();

  if (isMyTurn && gameMode === 'deferred' && commandQueue.length > 0) {
    renderDeferredPreview();
  }

  if (!wasMyTurn && isMyTurn) {
    playTurnSound();
    flashTurnAlert();
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

  const players = gameState.players || {};
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = Object.values(players).map(p => `<li>${p.name}</li>`).join('');

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

function getInviteLink() {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', roomCode);
  return url.toString();
}

async function copyInviteLink() {
  const link = getInviteLink();
  const feedback = document.getElementById('invite-link-feedback');
  try {
    await navigator.clipboard.writeText(link);
    if (feedback) {
      feedback.textContent = '✅ Lien copié !';
      setTimeout(() => { feedback.textContent = ''; }, 2500);
    }
  } catch (e) {
    window.prompt('Copiez ce lien :', link);
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
    playerOrder:   shuffled
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

      if (newScore >= WIN_SCORE) {
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

  const { state } = simulateQueue(player, gameState.objects, [action]);
  const logMsg = describeAction(action, player.name, state.direction);

  await roomRef.update({
    [`players/${myId}/x`]:         state.x,
    [`players/${myId}/y`]:         state.y,
    [`players/${myId}/direction`]: state.direction,
    [`players/${myId}/movesLeft`]: state.movesLeft
  });
  if (logMsg) await pushLog(logMsg);
}

// ============================================================
//  SIMULATION PURE (utilisée par le mode différé et le mode direct)
//  Ne touche jamais Firebase : calcule un état hypothétique
// ============================================================
function simulateQueue(basePlayer, baseObjects, queue) {
  const state = {
    x: basePlayer.x,
    y: basePlayer.y,
    direction: basePlayer.direction,
    movesLeft: basePlayer.movesLeft || 0,
    score: basePlayer.score || 0
  };
  const objects = { ...(baseObjects || {}) };
  const pickedKeys = [];

  queue.forEach(action => {
    if (ABS_DIR[action]) {
      const dir = ABS_DIR[action];
      const [dx, dy] = DIR_VECTORS[dir];
      state.x = clamp(state.x + dx, 0, GRID_SIZE - 1);
      state.y = clamp(state.y + dy, 0, GRID_SIZE - 1);
      state.direction = dir;
      state.movesLeft--;
      return;
    }
    switch (action) {
      case 'forward': {
        const [dx, dy] = DIR_VECTORS[state.direction];
        state.x = clamp(state.x + dx, 0, GRID_SIZE - 1);
        state.y = clamp(state.y + dy, 0, GRID_SIZE - 1);
        state.movesLeft--;
        break;
      }
      case 'backward': {
        const [dx, dy] = DIR_VECTORS[state.direction];
        state.x = clamp(state.x - dx, 0, GRID_SIZE - 1);
        state.y = clamp(state.y - dy, 0, GRID_SIZE - 1);
        state.movesLeft--;
        break;
      }
      case 'turnRight': {
        const idx = DIRECTIONS.indexOf(state.direction);
        state.direction = DIRECTIONS[(idx + 1) % 4];
        state.movesLeft--;
        break;
      }
      case 'turnLeft': {
        const idx = DIRECTIONS.indexOf(state.direction);
        state.direction = DIRECTIONS[(idx + 3) % 4];
        state.movesLeft--;
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
  });

  return { state, objects, pickedKeys };
}

// ============================================================
//  MODE DIFFÉRÉ : ajouter une commande à la file
// ============================================================
function playerActionDeferred(action) {
  const player = gameState.players[myId];
  if (!player) return;

  const before = simulateQueue(player, gameState.objects, commandQueue);

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

  const { state, objects } = simulateQueue(player, gameState.objects, commandQueue);

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
  list.innerHTML = commandQueue.map(a =>
    `<span class="queue-entry${a === 'pickup' ? ' queue-pickup' : ''}">${ACTION_LABELS[a] || a}</span>`
  ).join('');
}

// ============================================================
//  BASCULER ENTRE MODE DIRECT ET MODE DIFFÉRÉ (préférence locale)
// ============================================================
function setGameMode(mode) {
  if (commandQueue.length > 0) {
    addLocalLog('⚠️ File de commandes vidée suite au changement de mode.');
  }
  gameMode = mode;
  commandQueue = [];
  previewOverride = null;
  showGhostPreview = false;

  const ghostCheckbox = document.getElementById('ghost-checkbox');
  if (ghostCheckbox) ghostCheckbox.checked = false;

  const queuePanel = document.getElementById('queue-panel');
  if (queuePanel) queuePanel.style.display = (mode === 'deferred') ? 'block' : 'none';

  const ghostToggle = document.getElementById('ghost-toggle');
  if (ghostToggle) ghostToggle.style.display = (mode === 'deferred') ? 'block' : 'none';

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

  const { state: finalState, objects: objectsAfterPickup, pickedKeys } =
    simulateQueue(player, gameState.objects, commandQueue);

  const playerUpdates = {
    [`players/${myId}/x`]:         finalState.x,
    [`players/${myId}/y`]:         finalState.y,
    [`players/${myId}/direction`]: finalState.direction,
    [`players/${myId}/score`]:     finalState.score,
    [`players/${myId}/movesLeft`]: Math.max(0, finalState.movesLeft)
  };
  pickedKeys.forEach(key => { playerUpdates[`objects/${key}`] = null; });

  await roomRef.update(playerUpdates);

  if (commandQueue.length > 0) {
    await pushLog(`📝 ${player.name} exécute ${commandQueue.length} commande(s) (mode différé)`);
  }
  if (pickedKeys.length > 0) {
    await pushLog(`⭐ ${player.name} ramasse ${pickedKeys.length} objet(s) ! Score : ${finalState.score}`);
  }

  commandQueue = [];
  previewOverride = null;

  if (finalState.score >= WIN_SCORE) {
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
  const missing             = INIT_OBJECTS - currentObjectsCount;
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
    [`players/${nextId}/movesLeft`]: totalMoves
  };

  await roomRef.update(updates);
  await pushLog(`🔄 Tour ${newTurn} — ${nextPlayer.name} joue (+${bonusMoves} déplacements, total: ${totalMoves})`);
}

// ============================================================
//  FIN DE PARTIE
// ============================================================
async function finishGame(winnerId) {
  const players = gameState.players;
  const scoresSnapshot = {};
  Object.values(players).forEach(p => { scoresSnapshot[p.name] = p.score || 0; });

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
    countdownEl.textContent = `Nouvelle partie possible encore ${remaining}s si 2 joueurs ou plus votent "Oui".`;
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
    const scoresTxt = Object.entries(h.scores).map(([n, s]) => `${n}: ${s}`).join(' · ');
    return `<div class="history-entry">Partie ${h.gameNumber} — 🏆 ${h.winnerName} — ${scoresTxt}</div>`;
  }).join('');
}

async function castRematchVote(vote) {
  await roomRef.child(`rematchVotes/${myId}`).set(vote);
}

async function resolveRematch() {
  const votes = gameState.rematchVotes || {};
  const yesCount = Object.values(votes).filter(v => v === true).length;
  if (yesCount >= 2) {
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
      movesLeft: (id === firstId) ? movesForFirst : 0
    };
  });

  const gameNumber = (gameState.gameNumber || 1) + 1;
  const newObjects = generateObjects(INIT_OBJECTS, {});

  const updates = {
    status:        'playing',
    turn:          1,
    currentPlayer: firstId,
    playerOrder:   shuffled,
    players:       resetPlayers,
    objects:       newObjects,
    winner:        null,
    rematchVotes:  {},
    gameNumber:    gameNumber
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
    ctx.fillStyle = color;
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
        <span style="color:${color}">${id === myId ? '👤' : '🔵'} ${p.name}</span>
        <span>${p.score || 0}/${WIN_SCORE}</span>
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
//  BARRE DES JOUEURS (en haut de l'écran)
// ============================================================
function updatePlayersBar() {
  const bar = document.getElementById('players-bar');
  if (!bar) return;
  const players = gameState.players || {};

  bar.innerHTML = Object.entries(players).map(([id, p]) => {
    const color    = PLAYER_COLORS[p.colorIndex % PLAYER_COLORS.length];
    const isActive = id === gameState.currentPlayer;
    const isMe     = id === myId;
    return `
      <div class="player-chip${isActive ? ' active-chip' : ''}${isMe ? ' me-chip' : ''}">
        ${isActive ? '<div class="gamepad-icon">🎮</div>' : ''}
        <div class="chip-avatar" style="background:${color}">${p.name[0].toUpperCase()}</div>
        <div>
          <div class="chip-name">${p.name}${isMe ? ' (vous)' : ''}</div>
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
//  SIGNAL SONORE ET VISUEL DE TOUR
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
function randomMoves() {
  return Math.floor(Math.random() * 10) + 1;
}

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