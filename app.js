/* DULCE O TRUCO | Taller Supabase + PostgreSQL
   Lee GUIA_ALUMNOS.md antes de modificar este archivo.
   Los puntos SIEMPRE los calcula la función SQL play_door.
*/
'use strict';

const $ = (id) => document.getElementById(id);
const config = window.HALLOWEEN_CONFIG || {};
const configured = Boolean(
  /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test((config.url || '').trim()) &&
  (config.publishableKey || '').trim().length > 12
);
const supa = configured && window.supabase
  ? window.supabase.createClient(config.url.trim(), config.publishableKey.trim())
  : null;

let me = null;
let profile = null;
let doors = [
  {id:1,title:'Casa de la Bruja',emoji:'🧙',description:'Una bruja prepara dulces en su caldero.'},
  {id:2,title:'Cripta de Calabazas',emoji:'🎃',description:'Una calabaza guarda un secreto.'},
  {id:3,title:'Castillo Vampiro',emoji:'🧛',description:'La puerta del conde está entreabierta.'},
  {id:4,title:'Laboratorio Zombi',emoji:'🧟',description:'Se oyen ruidos desde el sótano.'},
  {id:5,title:'Bosque Fantasma',emoji:'👻',description:'Una voz susurra entre los árboles.'},
  {id:6,title:'Torre de Murciélagos',emoji:'🦇',description:'Algo misterioso vuela sobre la torre.'}
];
let myPlays = [];
let leaderboard = [];
let busy = false;
let realtimeChannel = null;
let refreshPending = false;

// Usar escape HTML para apodos y descripciones obtenidos desde la BD.
function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  })[c]);
}
function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5500);
}
function readableError(error) {
  if (!error) return 'Ocurrió un error desconocido.';
  if (error.message && /Failed to fetch|fetch failed|NetworkError/i.test(error.message))
    return 'No se pudo conectar con Supabase. Revisa tu Internet y la URL del proyecto.';
  return error.message || String(error);
}

function renderDoors() {
  const used = new Map(myPlays.map((p) => [Number(p.door_id), p]));
  const finished = myPlays.length >= 3;
  $('housesGrid').innerHTML = doors.map((door) => {
    const play = used.get(Number(door.id));
    const state = play ? (play.outcome === 'dulce' ? '🍬 DULCE' : '👻 TRUCO') : '';
    const points = play ? `${Number(play.points) > 0 ? '+' : ''}${Number(play.points)} pts` : '';
    let buttonText = 'Primero ingresa al juego';
    if (me) buttonText = finished ? 'Sin más turnos' : 'Abrir esta casa →';
    if (play) buttonText = `${state}: ${points}`;
    return `<article class="house-card ${play ? 'visited' : ''}">
      ${play ? `<span class="result-charm ${play.outcome === 'truco' ? 'trick' : ''}">${state}</span>` : ''}
      <div class="house-top"><div class="house-icon">${safe(door.emoji)}</div>${play ? '' : `<span class="house-number">CASA ${String(door.id).padStart(2,'0')}</span>`}</div>
      <h3>${safe(door.title)}</h3><p>${safe(door.description)}</p>
      <button class="house-action" data-door="${Number(door.id)}" ${play || !me || finished || busy ? 'disabled' : ''}>${buttonText}</button>
    </article>`;
  }).join('');
}

function renderStats() {
  if (!me || !profile) return;
  const score = myPlays.reduce((sum, p) => sum + Number(p.points), 0);
  $('myScore').textContent = String(score);
  $('usedTurns').textContent = String(myPlays.length);
  $('availableDoors').textContent = String(Math.max(doors.length - myPlays.length, 0));
  $('playerName').textContent = profile.nickname;
  $('joinSection').hidden = true;
  $('dashboard').hidden = false;
  if (myPlays.length >= 3) {
    $('gameCaption').textContent = '¡Terminaste tus 3 turnos! Compara tu resultado con los demás.';
  } else {
    $('gameCaption').textContent = `Tienes ${3 - myPlays.length} oportunidad(es). Cada casa solo se puede abrir una vez.`;
  }
}

function renderLeaderboard() {
  $('rankingIndicator').textContent = me ? 'Actualización en vivo' : 'Esperando jugadores';
  if (!me) return;
  if (!leaderboard.length) {
    $('rankingList').innerHTML = '<div class="empty-ranking">Todavía no hay participantes. ¡Sé el primero!</div>';
    return;
  }
  $('rankingList').innerHTML = leaderboard.map((player, index) => {
    const itsMe = player.id === me.id;
    const rank = index + 1;
    return `<div class="ranking-entry ${itsMe ? 'me' : ''}">
      <div class="rank-person"><span class="medal ${rank <= 3 ? 'top' : ''}">${rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '#' + rank}</span>
      <span class="person-name">${safe(player.nickname)}${itsMe ? '<span class="me-label">(TÚ)</span>' : ''}</span></div>
      <span class="score-amount ${Number(player.score) < 0 ? 'negative' : ''}">${Number(player.score) > 0 ? '+' : ''}${Number(player.score)}</span>
      <span class="turn-count">${Number(player.turns)}/3</span></div>`;
  }).join('');
  const index = leaderboard.findIndex((p) => p.id === me.id);
  $('playerRank').textContent = index >= 0 ? `🏆 Posición #${index + 1}` : '🏆 Jugando';
}

async function fetchLeaderboard() {
  if (!supa || !me) return;
  const {data, error} = await supa.from('leaderboard')
    .select('id,nickname,score,turns')
    .order('score', {ascending:false})
    .order('turns', {ascending:true})
    .limit(50);
  if (error) throw error;
  leaderboard = data || [];
  renderLeaderboard();
}

async function refreshAll() {
  if (!supa || !me) return;
  const [houseResult, playResult] = await Promise.all([
    supa.from('doors').select('id,title,emoji,description').eq('active',true).order('id'),
    supa.from('plays').select('door_id,outcome,points').eq('player_id', me.id)
  ]);
  if (houseResult.error) throw houseResult.error;
  if (playResult.error) throw playResult.error;
  doors = houseResult.data || [];
  myPlays = playResult.data || [];
  await fetchLeaderboard();
  renderStats();
  renderDoors();
}

async function refreshLeaderboardSafely() {
  if (refreshPending || !me) return;
  refreshPending = true;
  try { await fetchLeaderboard(); }
  catch (error) { console.warn('No se pudo refrescar ranking:', error); }
  finally { refreshPending = false; }
}

async function subscribeToLiveScores() {
  if (!supa || realtimeChannel) return;
  realtimeChannel = supa.channel('halloween-scoreboard')
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'plays'}, () => { void refreshLeaderboardSafely(); })
    .on('postgres_changes', {event:'INSERT', schema:'public', table:'players'}, () => { void refreshLeaderboardSafely(); })
    .subscribe((status) => {
      $('connectionStatus').textContent = status === 'SUBSCRIBED' ? '● EN VIVO' : 'Conectando…';
    });
}

async function startForUser(user) {
  me = user;
  const {data, error} = await supa.from('players').select('id,nickname').eq('id',user.id).maybeSingle();
  if (error) throw error;
  profile = data;
  if (!profile) {
    // Puede pasar cuando se completó Auth, pero se interrumpió la inserción.
    $('joinSection').hidden = false;
    notice('Tu sesión está activa. Escribe tu apodo para terminar de entrar.');
    return;
  }
  notice('');
  await refreshAll();
  await subscribeToLiveScores();
}

async function onJoin(event) {
  event.preventDefault();
  if (busy || !supa) return;
  const nick = $('nickname').value.trim();
  if (nick.length < 2 || nick.length > 20) {
    notice('El apodo debe tener de 2 a 20 caracteres.');
    return;
  }
  busy = true;
  $('joinButton').disabled = true;
  $('joinButton').textContent = 'Preparando aventura…';
  notice('');
  try {
    const {data: sessionData, error: sessionError} = await supa.auth.getSession();
    if (sessionError) throw sessionError;
    let user = sessionData.session?.user;
    if (!user) {
      const {data, error} = await supa.auth.signInAnonymously();
      if (error) throw error;
      user = data.user;
    }
    if (!user) throw new Error('No se pudo iniciar la sesión anónima.');
    const {data: current, error: readError} = await supa.from('players')
      .select('id,nickname').eq('id',user.id).maybeSingle();
    if (readError) throw readError;
    if (!current) {
      const {error: addError} = await supa.from('players').insert({id:user.id,nickname:nick});
      if (addError) throw addError;
    }
    await startForUser(user);
    toast('🎃 ¡Bienvenido al vecindario embrujado!');
  } catch (error) {
    notice(`No se pudo ingresar: ${readableError(error)}. Verifica que Anonymous Sign-Ins esté activado y que ejecutaste el SQL.`);
  } finally {
    busy = false;
    $('joinButton').disabled = false;
    $('joinButton').textContent = '¡Entrar al juego! →';
    renderDoors();
  }
}

async function onDoorClick(event) {
  const btn = event.target.closest('button[data-door]');
  if (!btn || !me || busy) return;
  const doorId = Number(btn.dataset.door);
  if (!Number.isInteger(doorId) || myPlays.some((p) => Number(p.door_id) === doorId) || myPlays.length >= 3) return;
  busy = true;
  renderDoors();
  try {
    const {data,error} = await supa.rpc('play_door', {p_door_id:doorId});
    if (error) throw error;
    const result = (data || [])[0];
    if (!result) throw new Error('La base de datos no devolvió el resultado.');
    await refreshAll();
    const plus = Number(result.points_earned) > 0 ? '+' : '';
    toast(result.outcome === 'dulce'
      ? `🍬 ¡DULCE! ${safe(result.door_name)}: ${plus}${result.points_earned} puntos.`
      : `👻 ¡TRUCO! ${safe(result.door_name)}: ${result.points_earned} puntos.`);
  } catch (error) {
    toast(`⚠️ ${readableError(error)}`);
    // Es posible que la jugada ya se guardara aunque falló la red.
    try { await refreshAll(); } catch (_) { /* El siguiente refresh recuperará el estado */ }
  } finally {
    busy = false;
    renderDoors();
  }
}

async function init() {
  renderDoors();
  $('joinForm').addEventListener('submit', onJoin);
  $('housesGrid').addEventListener('click', onDoorClick);
  if (!supa) {
    notice('MODO VISTA PREVIA: Para habilitar el juego, crea tu proyecto de Supabase y completa sitio/config.js con la URL y la publishable key.');
    $('connectionStatus').textContent = 'Vista previa';
    $('joinButton').disabled = true;
    return;
  }
  $('connectionStatus').textContent = 'Conectando…';
  try {
    const {data,error} = await supa.auth.getSession();
    if (error) throw error;
    if (data.session?.user) await startForUser(data.session.user);
    else {
      const {data: houseData, error: housesError} = await supa.from('doors')
        .select('id,title,emoji,description').eq('active',true).order('id');
      if (housesError) throw housesError;
      doors = houseData || doors;
      renderDoors();
      $('connectionStatus').textContent = '✓ Conectado';
    }
  } catch (error) {
    notice(`Error de configuración: ${readableError(error)}. Comprueba URL, publishable key y ejecución del script SQL.`);
    $('connectionStatus').textContent = 'Error de conexión';
  }
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
