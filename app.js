let pc;
let channel;
let receivedChunks = [];
let receivedBytes = 0;
let incomingFileInfo = null;
const CHUNK_SIZE = 16 * 1024;

// ─── Compression (fixed: no deprecated escape/unescape) ───
function compress(data) {
  const json = JSON.stringify(data);
  return btoa(encodeURIComponent(json).replace(/%([0-9A-F]{2})/g, (_, p1) =>
    String.fromCharCode(parseInt(p1, 16))
  ));
}
function decompress(data) {
  return JSON.parse(decodeURIComponent(
    atob(data).split("").map(c => "%" + c.charCodeAt(0).toString(16).padStart(2,"0")).join("")
  ));
}

// ─── Status / Log ─────────────────────────────────────────
function setStatus(text, type) {
  const el = document.getElementById("statusText");
  if (el) el.textContent = text;
  const light = document.getElementById("statusLight");
  if (light && type) light.className = "status-light status-" + type;
}
function log(msg, type) {
  const box = document.getElementById("logBox");
  if (!box) return;
  const line = document.createElement("div");
  line.className = "log-line log-" + (type || "info");
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  line.textContent = "[" + ts + "] " + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ─── ICE Server config ────────────────────────────────────
// STUN alone fails on org networks with symmetric NAT or strict UDP firewalls.
// TURN relays traffic through a server — works even behind corporate firewalls
// because it can use TCP port 443 (looks like HTTPS to the firewall).
//
// These are FREE public TURN servers from Metered.ca — fine for personal use.
// For production / heavy use, host your own: https://github.com/coturn/coturn
//
// ⚠ If your org blocks ALL external traffic you need a TURN server
//   running INSIDE your org network, or on a VPS your org allows.
const ICE_SERVERS = [
  // STUN — fast, free, no relay (works on open networks)
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },

  // TURN over UDP 3478 — first fallback for symmetric NAT
  {
    urls:       "turn:openrelay.metered.ca:80",
    username:   "openrelayproject",
    credential: "openrelayproject"
  },
  // TURN over TCP 80 — works when UDP is blocked
  {
    urls:       "turn:openrelay.metered.ca:80?transport=tcp",
    username:   "openrelayproject",
    credential: "openrelayproject"
  },
  // TURN over TCP 443 — looks like HTTPS, bypasses most firewalls
  {
    urls:       "turn:openrelay.metered.ca:443",
    username:   "openrelayproject",
    credential: "openrelayproject"
  },
  // TURNS (TLS) 443 — encrypted relay, gets through the strictest firewalls
  {
    urls:       "turns:openrelay.metered.ca:443?transport=tcp",
    username:   "openrelayproject",
    credential: "openrelayproject"
  }
];

// ─── Peer ─────────────────────────────────────────────────
function createPeer() {
  if (pc) { pc.close(); pc = null; }
  pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    // Try all candidate types; the browser auto-selects the best working path
    iceTransportPolicy: "all"
  });

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    log("Connection: " + s);
    const labels = { connected:"Connected", connecting:"Connecting...", disconnected:"Disconnected", failed:"Connection Failed", closed:"Closed", new:"Initializing..." };
    const types  = { connected:"connected", connecting:"connecting", new:"connecting", disconnected:"error", failed:"error", closed:"idle" };
    setStatus(labels[s] || s, types[s] || "idle");
    const ok = s === "connected";
    ["chatInput","sendMsgBtn","sendFileBtn","fileInput"].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = !ok;
    });
  };

  // Log ICE candidates so you can diagnose connection type (host/srflx/relay)
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const t = e.candidate.type || "?";
      // "relay" = TURN is being used, "srflx" = STUN, "host" = direct
      log("ICE candidate: " + t + " (" + (e.candidate.protocol || "?") + ")");
    }
  };

  pc.onicecandidateerror = (e) => {
    // 701 = TURN auth failed, 600 = unreachable — log but don't panic,
    // the browser tries all servers automatically
    if (e.errorCode !== 701) log("ICE error " + e.errorCode + ": " + e.errorText, "warn");
  };

  // ondatachannel fires on the answerer side
  pc.ondatachannel = (event) => { channel = event.channel; setupChannel(); };
}

// ─── Channel ──────────────────────────────────────────────
function setupChannel() {
  channel.binaryType = "arraybuffer";
  // Bug fix: onopen — enables UI when channel is truly ready
  channel.onopen = () => {
    log("Data channel open — ready!");
    setStatus("Connected", "connected");
    ["chatInput","sendMsgBtn","sendFileBtn","fileInput"].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = false;
    });
  };
  channel.onerror = (e) => { log("Channel error: " + (e.message || "unknown")); setStatus("Error", "error"); };
  channel.onclose = () => {
    log("Channel closed.");
    setStatus("Disconnected", "idle");
    ["chatInput","sendMsgBtn","sendFileBtn","fileInput"].forEach(id => {
      const el = document.getElementById(id); if (el) el.disabled = true;
    });
  };
  channel.onmessage = (e) => {
    // Bug fix: label as "peer" not hardcoded "User B"
    if (typeof e.data === "string" && e.data.startsWith("MSG:")) { addChat("peer", e.data.slice(4)); return; }
    // Bug fix: slice(5) instead of replace to avoid mangling data
    if (typeof e.data === "string" && e.data.startsWith("META:")) {
      incomingFileInfo = JSON.parse(e.data.slice(5));
      receivedChunks = []; receivedBytes = 0;
      log("Receiving: " + incomingFileInfo.name);
      updateProgress(0, "Receiving...");
      return;
    }
    if (typeof e.data === "string" && e.data === "EOF") { finalizeDownload(); return; }
    // Bug fix: track real bytes, not chunk_count * CHUNK_SIZE
    if (e.data instanceof ArrayBuffer) {
      receivedChunks.push(e.data); receivedBytes += e.data.byteLength;
      if (incomingFileInfo) updateProgress(Math.min(100, (receivedBytes / incomingFileInfo.size) * 100), "Receiving...");
    }
  };
}

// ─── Chat ─────────────────────────────────────────────────
function sendMessage() {
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (!msg) return;
  // Bug fix: check readyState, not just null
  if (!channel || channel.readyState !== "open") { log("Cannot send — not connected."); return; }
  channel.send("MSG:" + msg);
  addChat("you", msg); // Bug fix: "You" not hardcoded "User A"
  input.value = "";
}
function addChat(who, msg) {
  const box = document.getElementById("chatBox");
  const ph = box.querySelector(".chat-placeholder");
  if (ph) ph.remove();
  const row = document.createElement("div");
  row.className = "chat-row chat-" + who;
  const b = document.createElement("b");
  b.textContent = who === "you" ? "You: " : "Peer: ";
  row.appendChild(b);
  row.appendChild(document.createTextNode(msg));
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

// ─── Offer / Answer ───────────────────────────────────────
async function createOffer() {
  try {
    setStatus("Creating offer...", "connecting"); log("Creating offer..."); createPeer();
    channel = pc.createDataChannel("file"); setupChannel();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer); await waitIce();
    const encoded = compress(pc.localDescription);
    document.getElementById("offerBox").value = encoded;
    log("Offer ready — send to Peer B."); generateQR(encoded);
    setStatus("Waiting for answer...", "connecting");
  } catch (err) { log("Error: " + err.message); setStatus("Error", "error"); }
}
async function acceptOffer() {
  try {
    const raw = document.getElementById("offerBox").value.trim();
    if (!raw) { log("Paste the offer first!"); return; }
    setStatus("Processing offer...", "connecting"); log("Generating answer..."); createPeer();
    await pc.setRemoteDescription(decompress(raw));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer); await waitIce();
    const encoded = compress(pc.localDescription);
    document.getElementById("answerBox").value = encoded;
    log("Answer ready — send back to Peer A."); generateQR(encoded);
    setStatus("Waiting for Peer A...", "connecting");
  } catch (err) { log("Error: " + err.message); setStatus("Error", "error"); }
}
async function acceptAnswer() {
  try {
    const raw = document.getElementById("answerBox").value.trim();
    if (!raw) { log("Paste the answer first!"); return; }
    await pc.setRemoteDescription(decompress(raw));
    log("Answer accepted — connecting..."); setStatus("Connecting...", "connecting");
  } catch (err) { log("Error: " + err.message); setStatus("Error", "error"); }
}

// ─── ICE — Bug fix: addEventListener + timeout, no race ──
function waitIce() {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    const timeout = setTimeout(() => { log("ICE timeout — continuing."); resolve(); }, 10000);
    pc.addEventListener("icegatheringstatechange", function handler() {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(timeout); pc.removeEventListener("icegatheringstatechange", handler); resolve();
      }
    });
  });
}

// ─── File Send — Bug fix: readyState, file.type ───────────
async function sendFile() {
  const file = document.getElementById("fileInput").files[0];
  if (!file) { log("Select a file first."); return; }
  if (!channel || channel.readyState !== "open") { log("Not connected."); return; }
  log("Sending: " + file.name + " (" + formatBytes(file.size) + ")");
  // Bug fix: include file.type so receiver creates correct MIME blob
  channel.send("META:" + JSON.stringify({ name: file.name, size: file.size, type: file.type || "application/octet-stream" }));
  const buffer = await file.arrayBuffer();
  let offset = 0;
  while (offset < buffer.byteLength) {
    if (channel.bufferedAmount > 1_000_000) { await new Promise(r => setTimeout(r, 20)); continue; }
    channel.send(buffer.slice(offset, offset + CHUNK_SIZE));
    offset += CHUNK_SIZE;
    updateProgress(Math.min(100, (offset / file.size) * 100), "Sending...");
  }
  channel.send("EOF"); updateProgress(100, "Sent!"); log("Done: " + file.name);
}

// ─── File Receive — Bug fix: correct MIME type ────────────
function finalizeDownload() {
  const blob = new Blob(receivedChunks, { type: incomingFileInfo?.type || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = incomingFileInfo?.name || "download";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  updateProgress(100, "Received: " + (incomingFileInfo?.name || "file"));
  log("Received: " + (incomingFileInfo?.name || "file"));
  receivedChunks = []; receivedBytes = 0; incomingFileInfo = null;
}

// ─── Progress ─────────────────────────────────────────────
function updateProgress(pct, label) {
  pct = Math.min(100, Math.round(pct));
  const bar = document.getElementById("progressBar");
  const lbl = document.getElementById("progressLabel");
  if (bar) bar.style.width = pct + "%";
  if (lbl) lbl.textContent = (label || "") + " " + pct + "%";
}

// ─── Copy ─────────────────────────────────────────────────
function copyOffer() {
  const v = document.getElementById("offerBox").value; if (!v) return;
  navigator.clipboard.writeText(v).then(() => flash("copyOfferBtn", "Copied!"));
}
function copyAnswer() {
  const v = document.getElementById("answerBox").value; if (!v) return;
  navigator.clipboard.writeText(v).then(() => flash("copyAnswerBtn", "Copied!"));
}
function flash(id, text) {
  const btn = document.getElementById(id); const orig = btn.textContent;
  btn.textContent = text; setTimeout(() => btn.textContent = orig, 1500);
}

// ─── QR ───────────────────────────────────────────────────
function generateQR(data) {
  const mode = document.getElementById("mode").value;
  const qrDiv = document.getElementById("qr");
  qrDiv.innerHTML = "";
  if (mode === "qr") {
    if (data.length > 2500) { qrDiv.textContent = "Too large for QR — use Copy."; return; }
    new QRCode(qrDiv, { text: data, width: 150, height: 150 });
  }
}
document.getElementById("mode").addEventListener("change", () => {
  generateQR(document.getElementById("offerBox").value || document.getElementById("answerBox").value);
});

// ─── Bug fix: Enter key sends chat ────────────────────────
document.getElementById("chatInput").addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });

// ─── Utility ──────────────────────────────────────────────
function formatBytes(b) {
  if (b < 1024) return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}
window.addEventListener("DOMContentLoaded", () => {
  ["chatInput","sendMsgBtn","sendFileBtn","fileInput"].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = true;
  });
  setStatus("Not connected", "idle");
});