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
const GRID_SIZE      = 10;   // 10×10 cases
const CELL_SIZE      = 50;   // pixels par case
const WIN_SCORE      = 20;   // objets pour gagner
const INIT_OBJECTS   = 15;   // objets au démarrage
const DIRECTIONS     = ['N', 'E', 'S', 'W'];
const DIR_VECTORS    = { N:[0,-1], E:[1,0], S:[0,1], W:[-1,0] };
const DIR_ARROWS     = { N:'▲', E:'▶', S:'▼', W:'◀' };

// Couleurs joueurs
const PLAYER_COLORS  = ['#4CAF50','#2196F3','#FF5722','#9C27B0',
                         '#00BCD4','#FF9800','#E91E63','#8BC34A'];

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

// ============================================================
//  INITIALISATION FIREBASE
// ============================================================
firebase.initializeApp(firebaseConfig);
db = firebase.database();

// ============================================================
//  REJOINDRE / CRÉER UNE PARTIE
// ============================================================
async function joinGame() {
  myName   = document.getElementById('player-name').value.trim();
  roomCode = document.getElementById('room-code').value.trim().toUpperCase();
  const errEl = document.getElementById('login-error');

  if (!myName)     { errEl.textContent = 'Entrez votre pseudo.';       return; }
  if (!roomCode)   { errEl.textContent = 'Entrez un code de partie.';  return; }

  myId     = 'player_' + Date.now() + '_' + Math.random().toString(36).slice(2,7);
  roomRef  = db.ref('rooms/' + roomCode);

  const snap = await roomRef.once('value');

  if (!snap.exists()) {
    // ── Créer la partie ──
    const initialState = createInitialState();
    initialState.players[myId] = createPlayer(myName, 0);
    await roomRef.set(initialState);
    await pushLog(`Partie créée par ${myName}`);
  } else {
    // ── Rejoindre la partie ──
    const state = snap.val();
    if (state.status === 'finished') {
      errEl.textContent = 'Cette partie est terminée.';
      return;
    }
    const playerCount = Object.keys(state.players || {}).length;
    const colorIndex  = playerCount % PLAYER_COLORS.length;
    await roomRef.child('players/' + myId).set(createPlayer(myName, colorIndex));
    await pushLog(`${myName} a rejoint la partie`);
  }

  // Afficher l'écran de jeu
  document.getElementById('screen-login').classList.remove('active');
  document.getElementById('screen-game').classList.add('active');
  document.getElementById('display-room').textContent   = roomCode;
  document.getElementById('display-player').textContent = myName;

  // Initialiser le canvas
  canvas = document.getElementById('game-canvas');
  ctx    = canvas.getContext('2d');

  // Écouter les mises à jour Firebase
  roomRef.on('value', onStateUpdate);

  // Nettoyage si le joueur quitte
  window.addEventListener('beforeunload', () => {
    roomRef.child('players/' + myId).remove();
  });
}

// ============================================================
//  CRÉATION D'ÉTAT INITIAL
// ============================================================
function createInitialState() {
  const objects = generateObjects(INIT_OBJECTS, {});
  return {
    status:        'waiting',   // waiting | playing | finished
    turn:          0,
    currentPlayer: null,
    playerOrder:   [],
    players:       {},
    objects:       objects,
    log:           []
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
  if (!gameState.players)  gameState.players  = {};
  if (!gameState.objects)  gameState.objects  = {};
  if (!gameState.log)      gameState.log      = {};

  // Si la partie est en attente et qu'il y a au moins 2 joueurs → démarrer
  const playerIds = Object.keys(gameState.players);
  if (gameState.status === 'waiting' && playerIds.length >= 1) {
    // Le premier joueur connecté démarre la partie
    if (isFirstPlayer()) startGame(playerIds);
  }

  // Déterminer si c'est mon tour
  isMyTurn = (gameState.currentPlayer === myId && gameState.status === 'playing');
  updateUI();
  drawGrid();

  // Vérifier la victoire
  if (gameState.status === 'finished') showWinner();
}

function isFirstPlayer() {
  const ids = Object.keys(gameState.players);
  return ids.length > 0 && ids[0] === myId;
}

// ============================================================
//  DÉMARRAGE DE LA PARTIE
// ============================================================
async function startGame(playerIds) {
  if (gameState.status !== 'waiting') return;

  // Mélanger l'ordre des joueurs
  const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
  const firstId  = shuffled[0];

  // Attribuer des déplacements au premier joueur
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
//  ACTIONS DU JOUEUR
// ============================================================
async function playerAction(action) {
  if (!isMyTurn) return;
  const player = gameState.players[myId];
  if (!player) return;

  // Vérifier les déplacements restants (sauf ramasser)
  if (action !== 'pickup' && player.movesLeft <= 0) {
    addLocalLog('❌ Plus de déplacements !');
    return;
  }

  let newX = player.x;
  let newY = player.y;
  let newDir = player.direction;
  let newMoves = player.movesLeft;
  let logMsg = '';

  switch (action) {
    case 'forward': {
      const [dx, dy] = DIR_VECTORS[player.direction];
      newX = clamp(player.x + dx, 0, GRID_SIZE - 1);
      newY = clamp(player.y + dy, 0, GRID_SIZE - 1);
      newMoves--;
      logMsg = `${player.name} avance vers ${player.direction}`;
      break;
    }
    case 'backward': {
      const [dx, dy] = DIR_VECTORS[player.direction];
      newX = clamp(player.x - dx, 0, GRID_SIZE - 1);
      newY = clamp(player.y - dy, 0, GRID_SIZE - 1);
      newMoves--;
      logMsg = `${player.name} recule`;
      break;
    }
    case 'turnRight': {
      const idx = DIRECTIONS.indexOf(player.direction);
      newDir = DIRECTIONS[(idx + 1) % 4];
      newMoves--;
      logMsg = `${player.name} pivote à droite → ${newDir}`;
      break;
    }
    case 'turnLeft': {
      const idx = DIRECTIONS.indexOf(player.direction);
      newDir = DIRECTIONS[(idx + 3) % 4];
      newMoves--;
      logMsg = `${player.name} pivote à gauche → ${newDir}`;
      break;
    }
    case 'pickup': {
      const key = `${player.x}_${player.y}`;
      if (gameState.objects[key]) {
        const newScore = (player.score || 0) + 1;
        const updates  = {
          [`players/${myId}/score`]: newScore
        };
        // Supprimer l'objet
        updates[`objects/${key}`] = null;

        await roomRef.update(updates);
        await pushLog(`⭐ ${player.name} ramasse un objet ! Score : ${newScore}`);

        // Vérifier la victoire
        if (newScore >= WIN_SCORE) {
          await roomRef.update({ status: 'finished', winner: myId });
        }
        return;
      } else {
        addLocalLog('❌ Pas d\'objet ici !');
        return;
      }
    }
  }

  // Mettre à jour Firebase
  await roomRef.update({
    [`players/${myId}/x`]:         newX,
    [`players/${myId}/y`]:         newY,
    [`players/${myId}/direction`]:  newDir,
    [`players/${myId}/movesLeft`]:  newMoves
  });
  if (logMsg) await pushLog(logMsg);
}

// ============================================================
//  FIN DE TOUR
// ============================================================
async function endTurn() {
  if (!isMyTurn) return;

  const state       = gameState;
  const playerOrder = state.playerOrder || Object.keys(state.players);
  const currentIdx  = playerOrder.indexOf(myId);
  const nextIdx     = (currentIdx + 1) % playerOrder.length;
  const nextId      = playerOrder[nextIdx];

  // Calculer les objets ramassés ce tour (différence)
  // On régénère autant d'objets que ramassés pendant ce tour
  // (simplification : on compte les objets manquants vs INIT_OBJECTS)
  const currentObjects = Object.keys(state.objects || {}).length;
  const missing        = INIT_OBJECTS - currentObjects;
  let newObjects       = { ...state.objects };
  if (missing > 0) {
    newObjects = generateObjects(missing, newObjects);
  }

  // Nouveaux déplacements pour le prochain joueur
  const bonusMoves    = randomMoves();
  const nextPlayer    = state.players[nextId];
  const currentMoves  = nextPlayer ? (nextPlayer.movesLeft || 0) : 0;
  const totalMoves    = currentMoves + bonusMoves;
  const newTurn       = nextIdx === 0 ? (state.turn || 1) + 1 : (state.turn || 1);

  const updates = {
    currentPlayer:              nextId,
    turn:                       newTurn,
    objects:                    newObjects,
    [`players/${nextId}/movesLeft`]: totalMoves
  };

  await roomRef.update(updates);
  await pushLog(`🔄 Tour ${newTurn} — ${nextPlayer.name} joue (+${bonusMoves} déplacements, total: ${totalMoves})`);
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

  // Objets
  const objects = gameState.objects || {};
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
    const cx   = p.x * CELL_SIZE + CELL_SIZE / 2;
    const cy   = p.y * CELL_SIZE + CELL_SIZE / 2;
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

    // Bordure (moi = épaisse)
    ctx.strokeStyle = isMe ? '#fff' : '#000';
    ctx.lineWidth   = isMe ? 2.5 : 1;
    ctx.stroke();

    // Flèche de direction
    drawDirectionArrow(ctx, cx, cy, p.direction, color);

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

  // Scores
  const scoresList = document.getElementById('scores-list');
  scoresList.innerHTML = '';
  Object.entries(players)
    .sort((a, b) => (b[1].score || 0) - (a[1].score || 0))
    .forEach(([id, p]) => {
      const div  = document.createElement('div');
      div.className = 'score-entry' + (id === gameState.currentPlayer ? ' active-player' : '');
      const pct  = Math.min(100, ((p.score || 0) / WIN_SCORE) * 100);
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
  const btns = document.querySelectorAll('.ctrl-btn:not(.empty), #btn-end-turn');
  btns.forEach(b => {
    b.disabled = !isMyTurn;
    b.style.opacity = isMyTurn ? '1' : '0.4';
  });

  // Message d'attente
  document.getElementById('waiting-msg').style.display =
    isMyTurn ? 'none' : 'block';

  // Journal
  updateLog();
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
//  VICTOIRE
// ============================================================
function showWinner() {
  const modal = document.getElementById('modal-win');
  const msg   = document.getElementById('win-message');
  if (!gameState) return;

  const winner = gameState.players?.[gameState.winner];
  if (winner) {
    msg.textContent = gameState.winner === myId
      ? `🎉 Félicitations ${winner.name}, vous avez collecté ${winner.score} objets !`
      : `${winner.name} a gagné avec ${winner.score} objets !`;
  }
  modal.style.display = 'flex';
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
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.style.color = '#e94560';
  div.textContent = msg;
  logList.prepend(div);
}
