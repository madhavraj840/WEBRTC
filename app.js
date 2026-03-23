let pc;
let channel;

let receivedChunks = [];
let incomingFileInfo = null;

const CHUNK_SIZE = 16 * 1024;

// ---------- Compression ----------
function compress(data) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(data))));
}

function decompress(data) {
  return JSON.parse(decodeURIComponent(escape(atob(data))));
}

// ---------- Peer ----------
function createPeer() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
  });

  pc.onconnectionstatechange = () => {
    document.getElementById("status").innerText = pc.connectionState;
  };

  pc.ondatachannel = (event) => {
    channel = event.channel;
    setupChannel();
  };
}

// ---------- Channel ----------
function setupChannel() {
  channel.binaryType = "arraybuffer";

  channel.onmessage = (e) => {
    if (typeof e.data === "string") {

      if (e.data.startsWith("META:")) {
        incomingFileInfo = JSON.parse(e.data.replace("META:", ""));
        receivedChunks = [];
        return;
      }

      if (e.data === "EOF") {
        finalizeDownload();
        return;
      }
    }

    receivedChunks.push(e.data);

    if (incomingFileInfo) {
      let receivedSize = receivedChunks.length * CHUNK_SIZE;
      let percent = (receivedSize / incomingFileInfo.size) * 100;
      updateProgress(percent);
    }
  };
}

// ---------- Offer ----------
async function createOffer() {
  createPeer();

  channel = pc.createDataChannel("file");
  setupChannel();

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  await waitIce();

  const encoded = compress(pc.localDescription);
  document.getElementById("offerBox").value = encoded;

  generateQR(encoded);
}

// ---------- Answer ----------
async function acceptOffer() {
  createPeer();

  const offer = decompress(document.getElementById("offerBox").value);
  await pc.setRemoteDescription(offer);

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  await waitIce();

  const encoded = compress(pc.localDescription);
  document.getElementById("answerBox").value = encoded;

  generateQR(encoded);
}

async function acceptAnswer() {
  const answer = decompress(document.getElementById("answerBox").value);
  await pc.setRemoteDescription(answer);
}

// ---------- ICE ----------
function waitIce() {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") return resolve();
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") resolve();
    };
  });
}

// ---------- File Send ----------
async function sendFile() {
  const file = document.getElementById("fileInput").files[0];
  if (!file) return alert("Select file");

  channel.send("META:" + JSON.stringify({
    name: file.name,
    size: file.size
  }));

  const buffer = await file.arrayBuffer();
  let offset = 0;

  while (offset < buffer.byteLength) {

    if (channel.bufferedAmount > 1000000) {
      await new Promise(r => setTimeout(r, 20));
      continue;
    }

    const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
    channel.send(chunk);

    offset += CHUNK_SIZE;
    updateProgress((offset / file.size) * 100);
  }

  channel.send("EOF");
}

// ---------- Receive ----------
function finalizeDownload() {
  const blob = new Blob(receivedChunks);
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = incomingFileInfo ? incomingFileInfo.name : "file";
  a.click();

  receivedChunks = [];
  incomingFileInfo = null;
}

// ---------- Progress ----------
function updateProgress(p) {
  document.getElementById("progress").innerText =
    Math.min(100, Math.round(p)) + "%";
}

// ---------- Copy ----------
function copyOffer() {
  navigator.clipboard.writeText(document.getElementById("offerBox").value);
}

function copyAnswer() {
  navigator.clipboard.writeText(document.getElementById("answerBox").value);
}

// ---------- QR ----------
function generateQR(data) {
  const mode = document.getElementById("mode").value;
  const qrDiv = document.getElementById("qr");

  qrDiv.innerHTML = "";

  if (mode === "qr") {
    if (data.length > 2500) {
      qrDiv.innerText = "Too large for QR. Use copy.";
      return;
    }

    new QRCode(qrDiv, {
      text: data,
      width: 180,
      height: 180
    });
  }
}

document.getElementById("mode").addEventListener("change", () => {
  const data =
    document.getElementById("offerBox").value ||
    document.getElementById("answerBox").value;

  generateQR(data);
});