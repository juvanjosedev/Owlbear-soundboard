import OBR from "https://esm.sh/@owlbear-rodeo/sdk@2";

// ⚠️ Ajuste esta URL para o endpoint do seu Cloudflare Worker (veja README)
const UPLOAD_URL = "https://ebx-soundboard-upload.SEUSUBDOMINIO.workers.dev/upload";

const CHANNEL = "com.ebxdigital.soundboard/play";
const META_KEY = "com.ebxdigital.soundboard/sounds";
const VOLUME_KEY = "ebx_soundboard_volume";

let sounds = [];
let role = "PLAYER";
let volume = parseFloat(localStorage.getItem(VOLUME_KEY) ?? "0.8");
let audioUnlocked = false;

const listEl = document.getElementById("list");
const addBtn = document.getElementById("addBtn");
const fileInput = document.getElementById("fileInput");
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
    name.textContent = sound.name;

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
  OBR.broadcast.sendMessage(
    CHANNEL,
    { url: sound.url, id: sound.id },
    { destination: "ALL" }
  );
}

function playLocal(url) {
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

async function addSound(file) {
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
  if (file) addSound(file);
  fileInput.value = "";
});

volumeInput.addEventListener("input", () => {
  volume = parseFloat(volumeInput.value);
  localStorage.setItem(VOLUME_KEY, String(volume));
});

unlockBtn.addEventListener("click", () => {
  // Um clique real do usuário libera o áudio autoplay nesta aba a partir de agora
  const silent = new Audio();
  silent.play().catch(() => {});
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
    playLocal(event.data.url);
  });
});
