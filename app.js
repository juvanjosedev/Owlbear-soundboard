import OBR from "https://esm.sh/@owlbear-rodeo/sdk@2";

// ⚠️ Ajuste esta URL para o endpoint do seu Cloudflare Worker (veja README)
const UPLOAD_URL = "https://owlsound-upload.owlbearsoundboard.workers.dev/upload";

const CHANNEL = "com.owlsound.app/play";
const META_KEY = "com.owlsound.app/sounds";
const VOLUME_KEY = "owlsound_volume";
const YT_CONTAINER_ID = "yt-player-container";

let sounds = [];
let role = "PLAYER";
let volume = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "0.8");
let audioUnlocked = false;
let ytPlayer = null;
let ytReady = false;

const listEl = document.getElementById("list");
const addBtn = document.getElementById("addBtn");
const fileInput = document.getElementById("fileInput");
const ytInput = document.getElementById("ytInput");
const ytAddBtn = document.getElementById("ytAddBtn");
const volumeInput = document.getElementById("volume");
const statusEl = document.getElementById("status");
const unlockBtn = document.getElementById("unlockBtn");

volumeInput.value = String(volume);

function render() {
  listEl.innerHTML = "";

  if (sounds.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nenhum som adicionado ainda.";
    listEl.appendChild(empty);
    return;
  }

  for (const sound of sounds) {
    const row = document.createElement("div");
    row.className = "sound-row";

    const playBtn = document.createElement("button");
    playBtn.className = "play-btn";
    playBtn.textContent = "▶";
    playBtn.title = "Tocar para todos na sala";
    playBtn.onclick = () => playForEveryone(sound);

    const name = document.createElement("span");
    name.className = "sound-name";

    if (sound.type === "youtube") {
      const badge = document.createElement("span");
      badge.className = "yt-badge";
      badge.textContent = "YT";
      name.appendChild(badge);
    }
    name.appendChild(document.createTextNode(sound.name));

    row.appendChild(playBtn);
    row.appendChild(name);

    if (role === "GM") {
      const delBtn = document.createElement("button");
      delBtn.className = "del-btn";
      delBtn.textContent = "✕";
      delBtn.title = "Remover som";
      delBtn.onclick = () => removeSound(sound.id);
      row.appendChild(delBtn);
    }

    listEl.appendChild(row);
  }
}

function playForEveryone(sound) {
  const payload = { id: sound.id, type: sound.type || "audio" };
  if (sound.type === "youtube") {
    payload.videoId = sound.videoId;
    payload.start = sound.start || 0;
  } else {
    payload.url = sound.url;
  }
  OBR.broadcast.sendMessage(CHANNEL, payload, { destination: "ALL" });
}

function playLocal(data) {
  if (data.type === "youtube") {
    playYoutubeLocal(data.videoId, data.start || 0);
  } else {
    playAudioLocal(data.url);
  }
}

function playAudioLocal(url) {
  const audio = new Audio(url);
  audio.volume = volume;
  audio.play()
    .then(() => {
      audioUnlocked = true;
      unlockBtn.style.display = "none";
    })
    .catch(() => {
      // Navegador bloqueou autoplay: precisa de uma interação do usuário nesta aba
      if (!audioUnlocked) {
        unlockBtn.style.display = "block";
        statusEl.textContent = "Clique no botão acima para habilitar o áudio nesta aba.";
      }
    });
}

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

async function ensureYoutubePlayer() {
  if (ytPlayer && ytReady) return ytPlayer;
  await loadYoutubeApi();
  if (ytPlayer) return ytPlayer;
  return new Promise((resolve) => {
    ytPlayer = new YT.Player(YT_CONTAINER_ID, {
      height: "0",
      width: "0",
      playerVars: { autoplay: 0, controls: 0 },
      events: {
        onReady: () => {
          ytReady = true;
          resolve(ytPlayer);
        },
      },
    });
  });
}

async function playYoutubeLocal(videoId, start) {
  try {
    const player = await ensureYoutubePlayer();
    player.setVolume(Math.round(volume * 100));
    player.loadVideoById({ videoId, startSeconds: start });
    player.playVideo();
    audioUnlocked = true;
    unlockBtn.style.display = "none";
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

async function removeSound(id) {
  sounds = sounds.filter((s) => s.id !== id);
  await OBR.room.setMetadata({ [META_KEY]: sounds });
  render();
}

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

volumeInput.addEventListener("input", () => {
  volume = parseFloat(volumeInput.value);
  localStorage.setItem(VOLUME_KEY, String(volume));
  if (ytPlayer && ytReady) {
    try {
      ytPlayer.setVolume(Math.round(volume * 100));
    } catch {
      // player pode não estar pronto ainda
    }
  }
});

unlockBtn.addEventListener("click", () => {
  // Um clique real do usuário libera o áudio autoplay nesta aba a partir de agora
  const silent = new Audio();
  silent.play().catch(() => {});
  if (ytPlayer && ytReady) {
    try {
      ytPlayer.unMute();
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

  const metadata = await OBR.room.getMetadata();
  sounds = metadata[META_KEY] || [];
  render();

  OBR.room.onMetadataChange((metadata) => {
    sounds = metadata[META_KEY] || [];
    render();
  });

  OBR.broadcast.onMessage(CHANNEL, (event) => {
    playLocal(event.data);
  });
});
