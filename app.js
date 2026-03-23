let pc;
let channel;
let receivedChunks = [];
let receivedBytes  = 0;
let incomingFileInfo = null;

const CHUNK_SIZE = 16 * 1024;

// ── TURN + STUN — works on corporate / symmetric-NAT networks ────────────────
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80",              username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:80?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",              username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turns:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function compress(data) {
  const json = JSON.stringify(data);
  return btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g,
    (_, p1) => String.fromCharCode(parseInt(p1, 16))));
}

function decompress(data) {
  return JSON.parse(decodeURIComponent(
    atob(data).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2,"0")).join("")));
}

function log(msg, type) {
  const box = document.getElementById("logBox");
  if (!box) return;
  const div = document.createElement("div");
  div.className = "log-" + (type || "info");
  div.textContent = "[" + new Date().toLocaleTimeString("en-US",{hour12:false}) + "] " + msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setStatus(text, type) {
  const dot  = document.getElementById("statusDot");
  const span = document.getElementById("statusText");
  const sb   = document.getElementById("sbStatus");
  if (dot)  dot.className  = "dot dot-" + (type || "idle");
  if (span) span.textContent = text;
  if (sb)   sb.textContent   = text;
}

function setControlsEnabled(on) {
  ["chatInput","sendMsgBtn","sendFileBtn","fileInput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

function fmtBytes(b) {
  if (b < 1024)      return b + " B";
  if (b < 1048576)   return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function flash(id, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => btn.textContent = orig, 1500);
}

// ── Peer ──────────────────────────────────────────────────────────────────────
function createPeer() {
  if (pc) { pc.close(); pc = null; }

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceTransportPolicy: "all" });

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const labels = { connected:"Connected", connecting:"Connecting…", disconnected:"Disconnected", failed:"Connection failed", closed:"Closed", new:"Initialising…" };
    const types  = { connected:"connected", connecting:"connecting", new:"connecting", disconnected:"error", failed:"error", closed:"idle" };
    log("Connection: " + s, s === "connected" ? "ok" : s === "failed" ? "err" : "info");
    setStatus(labels[s] || s, types[s] || "idle");
    setControlsEnabled(s === "connected");
  };

  pc.onicecandidate = (e) => {
    if (e.candidate) log("ICE: " + (e.candidate.type||"?") + " / " + (e.candidate.protocol||"?"));
  };

  pc.onicecandidateerror = (e) => {
    if (e.errorCode !== 701) log("ICE error " + e.errorCode, "warn");
  };

  pc.ondatachannel = (e) => { channel = e.channel; setupChannel(); };
}

// ── Channel ───────────────────────────────────────────────────────────────────
function setupChannel() {
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    log("Channel open — ready!", "ok");
    setStatus("Connected", "connected");
    setControlsEnabled(true);
  };

  channel.onclose = () => {
    log("Channel closed.", "warn");
    setStatus("Disconnected", "idle");
    setControlsEnabled(false);
  };

  channel.onerror = (e) => {
    log("Channel error: " + (e.message || "unknown"), "err");
    setStatus("Error", "error");
  };

  channel.onmessage = (e) => {
    if (typeof e.data === "string") {
      if (e.data.startsWith("MSG:"))  { addChat("peer", e.data.slice(4)); return; }
      if (e.data.startsWith("META:")) {
        incomingFileInfo = JSON.parse(e.data.slice(5));
        receivedChunks = []; receivedBytes = 0;
        log("Receiving: " + incomingFileInfo.name + " (" + fmtBytes(incomingFileInfo.size) + ")");
        updateProgress(0, "Receiving…");
        return;
      }
      if (e.data === "EOF") { finalizeDownload(); return; }
    }
    if (e.data instanceof ArrayBuffer) {
      receivedChunks.push(e.data);
      receivedBytes += e.data.byteLength;
      if (incomingFileInfo)
        updateProgress(Math.min(100, (receivedBytes / incomingFileInfo.size) * 100), "Receiving…");
    }
  };
}

// ── Offer / Answer ────────────────────────────────────────────────────────────
async function createOffer() {
  try {
    setStatus("Creating offer…", "connecting");
    createPeer();
    channel = pc.createDataChannel("file");
    setupChannel();
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce();
    document.getElementById("offerBox").value = compress(pc.localDescription);
    log("Offer ready — copy and send to Peer B.", "ok");
    setStatus("Waiting for answer…", "connecting");
  } catch (err) { log("Error: " + err.message, "err"); setStatus("Error", "error"); }
}

async function acceptOffer() {
  try {
    const raw = document.getElementById("offerBox").value.trim();
    if (!raw) { log("Paste the offer first!", "warn"); return; }
    setStatus("Generating answer…", "connecting");
    createPeer();
    await pc.setRemoteDescription(decompress(raw));
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce();
    document.getElementById("answerBox").value = compress(pc.localDescription);
    log("Answer ready — copy and send back to Peer A.", "ok");
    setStatus("Waiting for Peer A…", "connecting");
  } catch (err) { log("Error: " + err.message, "err"); setStatus("Error", "error"); }
}

async function acceptAnswer() {
  try {
    const raw = document.getElementById("answerBox").value.trim();
    if (!raw) { log("Paste the answer first!", "warn"); return; }
    await pc.setRemoteDescription(decompress(raw));
    log("Answer accepted — connecting…", "ok");
    setStatus("Connecting…", "connecting");
  } catch (err) { log("Error: " + err.message, "err"); setStatus("Error", "error"); }
}

// ── ICE wait — uses addEventListener to avoid race condition ──────────────────
function waitIce() {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    const t = setTimeout(() => { log("ICE timeout — proceeding.", "warn"); resolve(); }, 10000);
    pc.addEventListener("icegatheringstatechange", function h() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t); pc.removeEventListener("icegatheringstatechange", h); resolve();
      }
    });
  });
}

// ── File send ─────────────────────────────────────────────────────────────────
async function sendFile() {
  const file = document.getElementById("fileInput").files[0];
  if (!file) { log("Select a file first.", "warn"); return; }
  if (!channel || channel.readyState !== "open") { log("Not connected.", "err"); return; }

  log("Sending: " + file.name + " (" + fmtBytes(file.size) + ")");
  channel.send("META:" + JSON.stringify({ name: file.name, size: file.size, type: file.type || "application/octet-stream" }));

  const buf = await file.arrayBuffer();
  let offset = 0;
  while (offset < buf.byteLength) {
    if (channel.bufferedAmount > 1_000_000) { await new Promise(r => setTimeout(r, 20)); continue; }
    channel.send(buf.slice(offset, offset + CHUNK_SIZE));
    offset += CHUNK_SIZE;
    updateProgress(Math.min(100, (offset / file.size) * 100), "Sending…");
  }
  channel.send("EOF");
  updateProgress(100, "Sent ✓");
  log("Sent: " + file.name, "ok");
}

// ── File receive ──────────────────────────────────────────────────────────────
function finalizeDownload() {
  const blob = new Blob(receivedChunks, { type: incomingFileInfo?.type || "application/octet-stream" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = incomingFileInfo?.name || "file";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  updateProgress(100, "Received: " + (incomingFileInfo?.name || "file"));
  log("Received: " + (incomingFileInfo?.name || "file"), "ok");
  receivedChunks = []; receivedBytes = 0; incomingFileInfo = null;
}

// ── Progress ──────────────────────────────────────────────────────────────────
function updateProgress(pct, label) {
  const p   = Math.min(100, Math.round(pct));
  const bar = document.getElementById("progressBar");
  const lbl = document.getElementById("progressLabel");
  if (bar) bar.style.width = p + "%";
  if (lbl) lbl.textContent = (label || "") + " " + p + "%";
}

// ── Chat ──────────────────────────────────────────────────────────────────────
function sendMessage() {
  const input = document.getElementById("chatInput");
  const msg   = input.value.trim();
  if (!msg) return;
  if (!channel || channel.readyState !== "open") { log("Not connected.", "err"); return; }
  channel.send("MSG:" + msg);
  addChat("you", msg);
  input.value = "";
}

function addChat(who, msg) {
  const box = document.getElementById("chatBox");
  const ph  = box.querySelector(".chat-empty");
  if (ph) ph.remove();
  const row = document.createElement("div");
  row.className = "chat-row-msg chat-" + who;
  const b = document.createElement("b");
  b.textContent = who === "you" ? "You: " : "Peer: ";
  row.appendChild(b);
  row.appendChild(document.createTextNode(msg));
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

// ── Copy ──────────────────────────────────────────────────────────────────────
function copyOffer() {
  const v = document.getElementById("offerBox").value;
  if (v) navigator.clipboard.writeText(v).then(() => flash("copyOfferBtn","Copied!"));
}

function copyAnswer() {
  const v = document.getElementById("answerBox").value;
  if (v) navigator.clipboard.writeText(v).then(() => flash("copyAnswerBtn","Copied!"));
}

// ── Enter key sends chat ──────────────────────────────────────────────────────
document.getElementById("chatInput").addEventListener("keydown", e => {
  if (e.key === "Enter") sendMessage();
});

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  setControlsEnabled(false);
  setStatus("Not connected", "idle");
  log("PeerDrop 95 ready. No server — pure peer-to-peer.");
});