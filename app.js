import OBR from "https://esm.sh/@owlbear-rodeo/sdk@2";

// ⚠️ Ajuste esta URL para o endpoint do seu Cloudflare Worker (veja README)
const UPLOAD_URL = "https://owlsound-upload.owlbearsoundboard.workers.dev/upload";

const CHANNEL = "com.owlsound.app/play";
const META_KEY = "com.owlsound.app/sounds";
const FOLDERS_KEY = "com.owlsound.app/folders";
const VOLUME_KEY = "owlsound_volume";
const SOUND_VOLUMES_KEY = "owlsound_sound_volumes";
const YT_CONTAINER_ID = "yt-player-container";

let sounds = [];
let folders = [];
let role = "PLAYER";
let volume = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "0.8");
let audioUnlocked = false;
// Volume individual de cada som (0 a 1), multiplicado pelo volume geral. Fica
// salvo localmente nesta aba/navegador, não é sincronizado com outros jogadores.
let soundVolumes = {};
try {
  soundVolumes = JSON.parse(localStorage.getItem(SOUND_VOLUMES_KEY) || "{}");
} catch {
  soundVolumes = {};
}
// Um player de YouTube por som (permite vários vídeos tocando ao mesmo tempo)
const ytPlayers = new Map(); // id -> instância YT.Player

// Áudios tocando agora nesta aba, indexados pelo id do som (permite pausar/parar um específico)
const activeAudio = new Map();
// Estado de reprodução LOCAL nesta aba: "playing" | "paused" (ausente = parado)
const soundState = new Map();
// Pastas recolhidas nesta aba (não é salvo, é só preferência visual local)
const collapsedFolders = new Set();

// Playlist automática (autoplay sequencial de uma pasta inteira)
let playlistQueue = [];
let playlistIndex = -1;
let playlistActive = false;
let activePlaylistFolderId = null; // pra saber qual pasta está com autoplay ativo, pra UI

const listEl = document.getElementById("list");
const addBtn = document.getElementById("addBtn");
const fileInput = document.getElementById("fileInput");
const ytInput = document.getElementById("ytInput");
const ytAddBtn = document.getElementById("ytAddBtn");
const volumeInput = document.getElementById("volume");
const statusEl = document.getElementById("status");
const unlockBtn = document.getElementById("unlockBtn");
const stopAllBtn = document.getElementById("stopAllBtn");
const gmToolbar = document.getElementById("gmToolbar");
const folderNameInput = document.getElementById("folderNameInput");
const createFolderBtn = document.getElementById("createFolderBtn");
const exportBtn = document.getElementById("exportBtn");
const importBtn = document.getElementById("importBtn");
const importFileInput = document.getElementById("importFileInput");
const exportModal = document.getElementById("exportModal");
const exportTextarea = document.getElementById("exportTextarea");
const copyExportBtn = document.getElementById("copyExportBtn");
const closeExportBtn = document.getElementById("closeExportBtn");

volumeInput.value = String(volume);

function getSoundVolume(id) {
  return typeof soundVolumes[id] === "number" ? soundVolumes[id] : 1;
}

function setSoundVolume(id, val) {
  soundVolumes[id] = val;
  localStorage.setItem(SOUND_VOLUMES_KEY, JSON.stringify(soundVolumes));
  applyLiveVolume(id);
}

function applyLiveVolume(id) {
  const effective = volume * getSoundVolume(id);
  const audio = activeAudio.get(id);
  if (audio) audio.volume = effective;
  const yt = ytPlayers.get(id);
  if (yt) {
    try {
      yt.setVolume(Math.round(effective * 100));
    } catch {
      // player pode não estar pronto ainda
    }
  }
}

// ---------- Renderização ----------

function render() {
  listEl.innerHTML = "";

  if (sounds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nenhum som adicionado ainda.";
    listEl.appendChild(empty);
    return;
  }

  const grouped = new Map();
  grouped.set(null, []);
  for (const f of folders) grouped.set(f.id, []);
  for (const s of sounds) {
    const key = grouped.has(s.folderId) ? s.folderId : null;
    grouped.get(key).push(s);
  }

  renderGroup(null, "Sem pasta", grouped.get(null));
  for (const f of folders) {
    renderGroup(f.id, f.name, grouped.get(f.id));
  }
}

function renderGroup(folderId, label, groupSounds) {
  // Não mostra pastas vazias pra jogadores comuns (só o GM precisa ver pra organizar)
  if (folderId !== null && groupSounds.length === 0 && role !== "GM") return;
  if (folderId === null && groupSounds.length === 0 && folders.length === 0) return;

  const section = document.createElement("div");
  section.className = "folder-section";

  const header = document.createElement("div");
  header.className = "folder-header";

  const collapseIcon = document.createElement("span");
  collapseIcon.className = "folder-collapse-icon";
  collapseIcon.textContent = collapsedFolders.has(folderId) ? "▸" : "▾";
  header.appendChild(collapseIcon);

  const title = document.createElement("span");
  title.className = "folder-title";
  title.textContent = `${label} (${groupSounds.length})`;
  header.appendChild(title);

  if (groupSounds.length > 0) {
    const isThisPlaylistActive = activePlaylistFolderId === folderId;
    const playlistBtn = document.createElement("button");
    playlistBtn.className = "folder-playlist-btn";
    playlistBtn.textContent = isThisPlaylistActive ? "⏹" : "▶";
    playlistBtn.title = isThisPlaylistActive
      ? "Parar a playlist desta pasta"
      : "Tocar esta pasta inteira em sequência, para todos";
    playlistBtn.onclick = (e) => {
      e.stopPropagation();
      if (isThisPlaylistActive) {
        stopPlaylistForEveryone();
      } else {
        playFolderForEveryone(
          folderId,
          groupSounds.map((s) => s.id)
        );
      }
    };
    header.appendChild(playlistBtn);
  }

  if (folderId !== null && role === "GM") {
    const delFolderBtn = document.createElement("button");
    delFolderBtn.className = "folder-del-btn";
    delFolderBtn.textContent = "✕";
    delFolderBtn.title = "Excluir pasta (os sons voltam para \"Sem pasta\")";
    delFolderBtn.onclick = (e) => {
      e.stopPropagation();
      deleteFolder(folderId);
    };
    header.appendChild(delFolderBtn);
  }

  header.addEventListener("click", () => {
    if (collapsedFolders.has(folderId)) collapsedFolders.delete(folderId);
    else collapsedFolders.add(folderId);
    render();
  });

  section.appendChild(header);

  const body = document.createElement("div");
  body.className = "folder-body" + (collapsedFolders.has(folderId) ? " hidden" : "");

  if (groupSounds.length === 0) {
    const emptyMsg = document.createElement("p");
    emptyMsg.className = "empty-folder";
    emptyMsg.textContent = "Nenhum som aqui.";
    body.appendChild(emptyMsg);
  } else {
    for (const sound of groupSounds) {
      body.appendChild(buildSoundRow(sound));
    }
  }

  section.appendChild(body);
  listEl.appendChild(section);
}

function buildSoundRow(sound) {
  const row = document.createElement("div");
  row.className = "sound-row";

  const state = soundState.get(sound.id);

  const playBtn = document.createElement("button");
  playBtn.className = "play-btn";
  playBtn.textContent = "▶";
  playBtn.title = "Tocar do início para todos na sala";
  playBtn.onclick = () => playForEveryone(sound);
  row.appendChild(playBtn);

  const pauseBtn = document.createElement("button");
  pauseBtn.className = "pause-btn";
  pauseBtn.textContent = state === "paused" ? "▶" : "⏸";
  pauseBtn.title =
    role === "GM"
      ? state === "paused"
        ? "Continuar (para todos)"
        : "Pausar (para todos)"
      : state === "paused"
      ? "Continuar (só para você)"
      : "Pausar (só para você)";
  pauseBtn.onclick = () => pauseOrResume(sound);
  row.appendChild(pauseBtn);

  const name = document.createElement("span");
  name.className = "sound-name";
  if (sound.type === "youtube") {
    const badge = document.createElement("span");
    badge.className = "yt-badge";
    badge.textContent = "YT";
    name.appendChild(badge);
  }
  name.appendChild(document.createTextNode(sound.name));
  row.appendChild(name);

  const soundVolumeInput = document.createElement("input");
  soundVolumeInput.type = "range";
  soundVolumeInput.className = "sound-volume";
  soundVolumeInput.min = "0";
  soundVolumeInput.max = "1";
  soundVolumeInput.step = "0.01";
  soundVolumeInput.value = String(getSoundVolume(sound.id));
  soundVolumeInput.title = "Volume individual deste som";
  soundVolumeInput.addEventListener("input", () => {
    setSoundVolume(sound.id, parseFloat(soundVolumeInput.value));
  });
  row.appendChild(soundVolumeInput);

  if (role === "GM") {
    const folderSelect = document.createElement("select");
    folderSelect.className = "folder-select";

    const noneOpt = document.createElement("option");
    noneOpt.value = "";
    noneOpt.textContent = "Sem pasta";
    folderSelect.appendChild(noneOpt);

    for (const f of folders) {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.name;
      folderSelect.appendChild(opt);
    }
    folderSelect.value = sound.folderId || "";
    folderSelect.onchange = () => moveSoundToFolder(sound.id, folderSelect.value || null);
    row.appendChild(folderSelect);

    const stopBtn = document.createElement("button");
    stopBtn.className = "stop-btn";
    stopBtn.textContent = "⏹";
    stopBtn.title = "Parar este som (para todos)";
    stopBtn.onclick = () => stopForEveryone(sound);
    row.appendChild(stopBtn);

    const delBtn = document.createElement("button");
    delBtn.className = "del-btn";
    delBtn.textContent = "✕";
    delBtn.title = "Remover som";
    delBtn.onclick = () => removeSound(sound);
    row.appendChild(delBtn);
  }

  return row;
}

// ---------- Play / Pause / Stop ----------

function playForEveryone(sound) {
  const payload = { op: "play", id: sound.id, type: sound.type || "audio" };
  if (sound.type === "youtube") {
    payload.videoId = sound.videoId;
    payload.start = sound.start || 0;
  } else {
    payload.url = sound.url;
  }
  OBR.broadcast.sendMessage(CHANNEL, payload, { destination: "ALL" });
}

function pauseOrResume(sound) {
  const state = soundState.get(sound.id);

  if (state === "playing") {
    if (role === "GM") {
      OBR.broadcast.sendMessage(CHANNEL, { op: "pause", id: sound.id }, { destination: "ALL" });
    }
    pauseLocal(sound.id);
  } else if (state === "paused") {
    if (role === "GM") {
      OBR.broadcast.sendMessage(CHANNEL, { op: "resume", id: sound.id }, { destination: "ALL" });
    }
    resumeLocal(sound.id);
  }
  // Se não estiver tocando nada, não faz nada (não há o que pausar/continuar)
}

function stopForEveryone(sound) {
  OBR.broadcast.sendMessage(CHANNEL, { op: "stop", id: sound.id }, { destination: "ALL" });
}

function stopAllForEveryone() {
  OBR.broadcast.sendMessage(CHANNEL, { op: "stopAll" }, { destination: "ALL" });
}

function playFolderForEveryone(folderId, ids) {
  OBR.broadcast.sendMessage(
    CHANNEL,
    { op: "playPlaylist", folderId, ids },
    { destination: "ALL" }
  );
}

function stopPlaylistForEveryone() {
  OBR.broadcast.sendMessage(CHANNEL, { op: "stopPlaylist" }, { destination: "ALL" });
}

function startPlaylistLocal(folderId, ids) {
  // Cancela qualquer playlist anterior em andamento nesta aba antes de começar a nova
  if (playlistActive) {
    stopPlaylistLocal();
  }

  if (!ids || ids.length === 0) return;

  activePlaylistFolderId = folderId;
  playlistActive = true;
  playlistQueue = [...ids];
  playlistIndex = -1;
  advancePlaylist();
}

function advancePlaylist() {
  playlistIndex++;

  if (!playlistActive || playlistIndex >= playlistQueue.length) {
    playlistActive = false;
    playlistQueue = [];
    playlistIndex = -1;
    activePlaylistFolderId = null;
    render();
    return;
  }

  const id = playlistQueue[playlistIndex];
  const sound = sounds.find((s) => s.id === id);

  if (!sound) {
    // Som foi removido nesse meio tempo: pula pro próximo da fila
    advancePlaylist();
    return;
  }

  playLocal({
    id: sound.id,
    type: sound.type || "audio",
    url: sound.url,
    videoId: sound.videoId,
    start: sound.start || 0,
  });
  render();
}

function stopPlaylistLocal() {
  const currentId = playlistActive ? playlistQueue[playlistIndex] : null;
  playlistActive = false;
  playlistQueue = [];
  playlistIndex = -1;
  activePlaylistFolderId = null;
  if (currentId) {
    fadeOutAndStop(currentId);
  } else {
    render();
  }
}

function handleBroadcast(data) {
  if (data.op === "stop") stopLocal(data.id);
  else if (data.op === "stopAll") stopAllLocal();
  else if (data.op === "play") playLocal(data);
  else if (data.op === "pause") pauseLocal(data.id);
  else if (data.op === "resume") resumeLocal(data.id);
  else if (data.op === "playPlaylist") startPlaylistLocal(data.folderId, data.ids);
  else if (data.op === "stopPlaylist") stopPlaylistLocal();
}

function playLocal(data) {
  if (data.type === "youtube") {
    playYoutubeLocal(data.id, data.videoId, data.start || 0);
  } else {
    playAudioLocal(data.id, data.url);
  }
}

function playAudioLocal(id, url) {
  clearFade(id);

  const existing = activeAudio.get(id);
  if (existing) {
    existing.pause();
    activeAudio.delete(id);
  }

  const audio = new Audio(url);
  audio.volume = volume * getSoundVolume(id);
  audio.addEventListener("ended", () => {
    activeAudio.delete(id);
    soundState.delete(id);
    render();
    if (playlistActive && playlistQueue[playlistIndex] === id) {
      advancePlaylist();
    }
  });
  activeAudio.set(id, audio);

  audio
    .play()
    .then(() => {
      audioUnlocked = true;
      unlockBtn.style.display = "none";
      soundState.set(id, "playing");
      render();
    })
    .catch(() => {
      activeAudio.delete(id);
      if (!audioUnlocked) {
        unlockBtn.style.display = "block";
        statusEl.textContent = "Clique no botão acima para habilitar o áudio nesta aba.";
      }
    });
}

function pauseLocal(id) {
  const audio = activeAudio.get(id);
  if (audio) {
    audio.pause();
    soundState.set(id, "paused");
    render();
    return;
  }
  const yt = ytPlayers.get(id);
  if (yt) {
    try {
      yt.pauseVideo();
    } catch {
      // ignora se o player não estiver pronto
    }
    soundState.set(id, "paused");
    render();
  }
}

function resumeLocal(id) {
  const audio = activeAudio.get(id);
  if (audio) {
    audio.play().catch(() => {});
    soundState.set(id, "playing");
    render();
    return;
  }
  const yt = ytPlayers.get(id);
  if (yt) {
    try {
      yt.playVideo();
    } catch {
      // ignora se o player não estiver pronto
    }
    soundState.set(id, "playing");
    render();
  }
}

function stopLocal(id) {
  fadeOutAndStop(id);
}

function stopAllLocal() {
  // Cancela a playlist automática também, senão ela tentaria avançar pro próximo som
  playlistActive = false;
  playlistQueue = [];
  playlistIndex = -1;
  activePlaylistFolderId = null;

  const ids = new Set([...activeAudio.keys(), ...ytPlayers.keys()]);
  for (const id of ids) {
    if (soundState.get(id)) fadeOutAndStop(id);
  }
}

const FADE_MS = 1200;
const fadeTimers = new Map(); // id -> intervalId, pra poder cancelar um fade em andamento

function clearFade(id) {
  const t = fadeTimers.get(id);
  if (t) {
    clearInterval(t);
    fadeTimers.delete(id);
  }
}

function fadeOutAndStop(id) {
  clearFade(id);

  const audio = activeAudio.get(id);
  const yt = ytPlayers.get(id);

  if (!audio && !yt) {
    soundState.delete(id);
    render();
    return;
  }

  const targetVolume = volume * getSoundVolume(id);
  const steps = 20;
  const stepMs = FADE_MS / steps;
  let step = 0;

  const interval = setInterval(() => {
    step++;
    const factor = Math.max(0, 1 - step / steps);
    if (audio) audio.volume = targetVolume * factor;
    if (yt) {
      try {
        yt.setVolume(Math.round(targetVolume * factor * 100));
      } catch {
        // ignora se o player não estiver pronto
      }
    }

    if (step >= steps) {
      clearInterval(interval);
      fadeTimers.delete(id);
      finalizeStop(id, targetVolume);
    }
  }, stepMs);

  fadeTimers.set(id, interval);
}

function finalizeStop(id, restoreVolume) {
  const audio = activeAudio.get(id);
  if (audio) {
    audio.pause();
    audio.currentTime = 0;
    activeAudio.delete(id);
  }
  const yt = ytPlayers.get(id);
  if (yt) {
    try {
      yt.stopVideo();
      if (typeof restoreVolume === "number") {
        yt.setVolume(Math.round(restoreVolume * 100));
      }
    } catch {
      // ignora se o player não estiver pronto
    }
  }
  soundState.delete(id);
  render();

  if (playlistActive && playlistQueue[playlistIndex] === id) {
    advancePlaylist();
  }
}

// ---------- YouTube ----------

function loadYoutubeApi() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) {
      resolve();
      return;
    }
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (typeof previous === "function") previous();
      resolve();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
  });
}

function createYoutubePlayerContainer(id) {
  const containerId = `yt-player-${id}`;
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement("div");
    container.id = containerId;
    document.getElementById(YT_CONTAINER_ID).appendChild(container);
  }
  return containerId;
}

async function ensureYoutubePlayerFor(id) {
  if (ytPlayers.has(id)) return ytPlayers.get(id);
  await loadYoutubeApi();
  const containerId = createYoutubePlayerContainer(id);
  return new Promise((resolve) => {
    const player = new YT.Player(containerId, {
      height: "0",
      width: "0",
      playerVars: { autoplay: 0, controls: 0 },
      events: {
        onReady: () => {
          ytPlayers.set(id, player);
          resolve(player);
        },
        onStateChange: (e) => {
          if (window.YT && e.data === window.YT.PlayerState.ENDED) {
            soundState.delete(id);
            render();
            if (playlistActive && playlistQueue[playlistIndex] === id) {
              advancePlaylist();
            }
          }
        },
      },
    });
  });
}

async function playYoutubeLocal(id, videoId, start) {
  clearFade(id);
  try {
    const player = await ensureYoutubePlayerFor(id);
    player.setVolume(Math.round(volume * getSoundVolume(id) * 100));
    player.loadVideoById({ videoId, startSeconds: start });
    player.playVideo();
    audioUnlocked = true;
    unlockBtn.style.display = "none";
    soundState.set(id, "playing");
    render();
  } catch (err) {
    console.error(err);
    if (!audioUnlocked) {
      unlockBtn.style.display = "block";
      statusEl.textContent = "Clique no botão acima para habilitar o áudio nesta aba.";
    }
  }
}

function extractYoutubeId(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    const host = u.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return u.pathname.slice(1).split("/")[0] || null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (u.pathname === "/watch") {
        return u.searchParams.get("v");
      }
      const match = u.pathname.match(/^\/(shorts|live|embed)\/([^/]+)/);
      if (match) return match[2];
    }

    return null;
  } catch {
    return null;
  }
}

function extractYoutubeStart(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    const t = u.searchParams.get("t") || u.searchParams.get("start");
    if (!t) return 0;
    if (/^\d+$/.test(t)) return parseInt(t, 10);
    const match = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    if (!match) return 0;
    const h = parseInt(match[1] || "0", 10);
    const m = parseInt(match[2] || "0", 10);
    const s = parseInt(match[3] || "0", 10);
    return h * 3600 + m * 60 + s;
  } catch {
    return 0;
  }
}

// ---------- Adicionar / remover sons ----------

async function addYoutubeSound(rawUrl) {
  const videoId = extractYoutubeId(rawUrl);
  if (!videoId) {
    statusEl.textContent = "Link do YouTube inválido.";
    return;
  }

  const start = extractYoutubeStart(rawUrl);
  statusEl.textContent = "Adicionando vídeo do YouTube...";

  let title = `YouTube (${videoId})`;
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        "https://www.youtube.com/watch?v=" + videoId
      )}&format=json`
    );
    if (res.ok) {
      const data = await res.json();
      if (data.title) title = data.title;
    }
  } catch {
    // Sem internet pro oEmbed ou bloqueado: segue com o título padrão
  }

  const newSound = {
    id: crypto.randomUUID(),
    name: title,
    type: "youtube",
    videoId,
    start,
    folderId: null,
  };

  sounds = [...sounds, newSound];
  await OBR.room.setMetadata({ [META_KEY]: sounds });
  render();
  statusEl.textContent = "";
}

async function addAudioSound(file) {
  statusEl.textContent = "Enviando som...";
  const form = new FormData();
  form.append("file", file);

  try {
    const res = await fetch(UPLOAD_URL, { method: "POST", body: form });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || "Falha no upload");
    }
    const data = await res.json();

    const newSound = {
      id: crypto.randomUUID(),
      name: file.name.replace(/\.[^/.]+$/, ""),
      type: "audio",
      url: data.url,
      folderId: null,
    };

    sounds = [...sounds, newSound];
    await OBR.room.setMetadata({ [META_KEY]: sounds });
    render();
    statusEl.textContent = "";
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Erro ao enviar o som. Veja o console.";
  }
}

async function removeSound(sound) {
  stopForEveryone(sound);
  stopLocal(sound.id);

  sounds = sounds.filter((s) => s.id !== sound.id);
  await OBR.room.setMetadata({ [META_KEY]: sounds });
  render();
}

// ---------- Pastas ----------

async function createFolder(name) {
  const trimmed = name.trim();
  if (!trimmed) return;

  folders = [...folders, { id: crypto.randomUUID(), name: trimmed }];
  await OBR.room.setMetadata({ [FOLDERS_KEY]: folders });
  render();
}

async function deleteFolder(folderId) {
  folders = folders.filter((f) => f.id !== folderId);
  sounds = sounds.map((s) => (s.folderId === folderId ? { ...s, folderId: null } : s));
  await OBR.room.setMetadata({ [META_KEY]: sounds, [FOLDERS_KEY]: folders });
  render();
}

async function moveSoundToFolder(soundId, folderId) {
  sounds = sounds.map((s) => (s.id === soundId ? { ...s, folderId } : s));
  await OBR.room.setMetadata({ [META_KEY]: sounds });
  render();
}

// ---------- Exportar / Importar playlist ----------

function showExportModal(json) {
  exportTextarea.value = json;
  exportModal.classList.remove("hidden");
}

function exportPlaylist() {
  const data = { folders, sounds };
  const json = JSON.stringify(data, null, 2);

  // Mostra num modal com o texto pronto pra copiar, garantindo que funcione mesmo
  // se o download automático abaixo for bloqueado pelo iframe da extensão.
  showExportModal(json);

  try {
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "owlsound-playlist.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // Sem problema, o modal acima já cobre esse caso
  }
}

async function importPlaylist(file) {
  let data;
  try {
    const text = await file.text();
    data = JSON.parse(text);
  } catch {
    statusEl.textContent = "Arquivo inválido (não é um JSON válido).";
    return;
  }

  if (!data || !Array.isArray(data.sounds)) {
    statusEl.textContent = "Formato de playlist inválido.";
    return;
  }

  const importedFolders = Array.isArray(data.folders) ? data.folders : [];
  const folderIdMap = new Map();
  const newFolders = importedFolders.map((f) => {
    const newId = crypto.randomUUID();
    folderIdMap.set(f.id, newId);
    return { id: newId, name: f.name || "Pasta" };
  });

  const newSounds = data.sounds
    .filter((s) => s && (s.url || s.videoId))
    .map((s) => ({
      id: crypto.randomUUID(),
      name: s.name || "Sem nome",
      type: s.type === "youtube" ? "youtube" : "audio",
      url: s.url,
      videoId: s.videoId,
      start: s.start || 0,
      folderId: s.folderId ? folderIdMap.get(s.folderId) || null : null,
    }));

  folders = [...folders, ...newFolders];
  sounds = [...sounds, ...newSounds];
  await OBR.room.setMetadata({ [META_KEY]: sounds, [FOLDERS_KEY]: folders });
  render();
  statusEl.textContent = `Importado: ${newSounds.length} som(ns), ${newFolders.length} pasta(s).`;
}

// ---------- Permissões ----------

function applyRolePermissions() {
  const isGM = role === "GM";
  addBtn.style.display = isGM ? "" : "none";
  ytInput.parentElement.style.display = isGM ? "" : "none"; // .yt-row
  stopAllBtn.style.display = isGM ? "" : "none";
  gmToolbar.style.display = isGM ? "" : "none";
}

// ---------- Eventos ----------

addBtn.addEventListener("click", () => fileInput.click());

fileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) addAudioSound(file);
  fileInput.value = "";
});

ytAddBtn.addEventListener("click", () => {
  const url = ytInput.value.trim();
  if (url) {
    addYoutubeSound(url);
    ytInput.value = "";
  }
});

ytInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") ytAddBtn.click();
});

stopAllBtn.addEventListener("click", () => {
  stopAllForEveryone();
  stopAllLocal();
});

createFolderBtn.addEventListener("click", () => {
  createFolder(folderNameInput.value);
  folderNameInput.value = "";
});

folderNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") createFolderBtn.click();
});

exportBtn.addEventListener("click", exportPlaylist);

importBtn.addEventListener("click", () => importFileInput.click());

importFileInput.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) importPlaylist(file);
  importFileInput.value = "";
});

closeExportBtn.addEventListener("click", () => exportModal.classList.add("hidden"));

copyExportBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(exportTextarea.value);
    statusEl.textContent = "Texto copiado!";
  } catch {
    exportTextarea.select();
    document.execCommand("copy");
    statusEl.textContent = "Texto copiado!";
  }
});

volumeInput.addEventListener("input", () => {
  volume = parseFloat(volumeInput.value);
  localStorage.setItem(VOLUME_KEY, String(volume));
  for (const id of activeAudio.keys()) {
    applyLiveVolume(id);
  }
  for (const id of ytPlayers.keys()) {
    applyLiveVolume(id);
  }
});

unlockBtn.addEventListener("click", () => {
  const silent = new Audio();
  silent.play().catch(() => {});
  for (const yt of ytPlayers.values()) {
    try {
      yt.unMute();
    } catch {
      // ignora se ainda não estiver pronto
    }
  }
  audioUnlocked = true;
  unlockBtn.style.display = "none";
  statusEl.textContent = "";
});

OBR.onReady(async () => {
  role = await OBR.player.getRole();
  applyRolePermissions();

  const metadata = await OBR.room.getMetadata();
  sounds = metadata[META_KEY] || [];
  folders = metadata[FOLDERS_KEY] || [];
  render();

  OBR.room.onMetadataChange((metadata) => {
    sounds = metadata[META_KEY] || [];
    folders = metadata[FOLDERS_KEY] || [];
    render();
  });

  OBR.broadcast.onMessage(CHANNEL, (event) => {
    handleBroadcast(event.data);
  });
});
