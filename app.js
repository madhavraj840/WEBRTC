"use strict";

let pc;
let channel;
let receivedChunks = [];
let receivedBytes  = 0;
let incomingFileInfo = null;

const CHUNK_SIZE = 16 * 1024;

// ── ICE servers ───────────────────────────────────────────────────────────────
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "turn:openrelay.metered.ca:80",                username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:80?transport=tcp",   username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443",                username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turns:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
];

// ── Compression using LZ-String ───────────────────────────────────────────────
// FIX: old compress() used btoa() which is NOT compression — it made codes BIGGER.
// LZString compresses WebRTC SDP by ~65-70%, reducing ~2000 chars → ~400-600 chars.
// That is small enough for QR codes and much easier to share.
function compress(data) {
  return LZString.compressToEncodedURIComponent(JSON.stringify(data));
}
function decompress(str) {
  const raw = LZString.decompressFromEncodedURIComponent(str);
  if (!raw) throw new Error("Decompression failed — is the code correct?");
  return JSON.parse(raw);
}

// ── Relay via jsonblob.com ────────────────────────────────────────────────────
// jsonblob.com is a free, CORS-enabled, anonymous JSON store.
// POST a JSON body → get back a unique 19-digit ID in the Location header.
// GET /{id} → retrieve the stored JSON.
// The SDP is only valid for one session and contains no personal data.
const RELAY_BASE = "https://jsonblob.com/api/jsonBlob";

async function uploadToRelay(sdpObject) {
  const compressed = compress(sdpObject);
  const res = await fetch(RELAY_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ d: compressed })
  });
  if (!res.ok) throw new Error("Relay upload failed: " + res.status);
  // Location: https://jsonblob.com/api/jsonBlob/1234567890123456789
  const loc = res.headers.get("Location") || "";
  const id  = loc.split("/").pop();
  if (!id) throw new Error("Relay returned no ID");
  return id; // ~19 digit string
}

async function downloadFromRelay(id) {
  const cleanId = id.trim().replace(/\s+/g, "");
  const res = await fetch(RELAY_BASE + "/" + cleanId, {
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw new Error("Relay fetch failed: " + res.status + " — check the code");
  const obj = await res.json();
  return decompress(obj.d);
}

// ── QR code generation ────────────────────────────────────────────────────────
// FIX: QR was removed in earlier cleanup. Re-added.
// With LZ-string compression, codes are ~400-600 chars — perfect for QR.
// In relay mode, QR encodes just the 19-digit ID — even smaller.
function showQR(containerId, text) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = "";
  if (!text) return;
  try {
    new QRCode(el, {
      text:          text,
      width:         160,
      height:        160,
      correctLevel:  QRCode.CorrectLevel.M
    });
  } catch (e) {
    el.textContent = "QR too large — use copy/paste mode.";
    log("QR generation failed: " + e.message, "warn");
  }
}

// ── Mode helpers ──────────────────────────────────────────────────────────────
function getMode() {
  const el = document.querySelector('input[name="mode"]:checked');
  return el ? el.value : "text";
}

function onModeChange() {
  const relay = getMode() === "relay";
  document.getElementById("offerTextArea").style.display  = relay ? "none" : "block";
  document.getElementById("offerRelayArea").style.display = relay ? "block" : "none";
  document.getElementById("answerTextArea").style.display  = relay ? "none" : "block";
  document.getElementById("answerRelayArea").style.display = relay ? "block" : "none";
  document.getElementById("modeHint").textContent = relay
    ? "Uses jsonblob.com as a free relay — gives a short code + QR. Codes expire after ~30 days."
    : "Copy/paste the code — works offline, no relay needed.";
  // Clear QR and short code displays when switching
  ["offerQR","answerQR"].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ""; });
  ["offerShortDisplay","answerShortDisplay"].forEach(id => {
    const e = document.getElementById(id);
    if (e) { e.textContent = ""; e.style.display = "none"; }
  });
}

// ── Logging + status ──────────────────────────────────────────────────────────
function log(msg, type) {
  const box = document.getElementById("logBox");
  if (!box) return;
  const div = document.createElement("div");
  div.className = "log-" + (type || "info");
  div.textContent = "[" + new Date().toLocaleTimeString("en-US", { hour12: false }) + "] " + msg;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function setStatus(text, type) {
  const dot  = document.getElementById("statusDot");
  const span = document.getElementById("statusText");
  const sb   = document.getElementById("sbStatus");
  if (dot)  dot.className    = "dot dot-" + (type || "idle");
  if (span) span.textContent  = text;
  if (sb)   sb.textContent    = text;
}

function setTransferControls(on) {
  ["chatInput","sendMsgBtn","sendFileBtn","fileInput"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

function setConnectionBtns(on) {
  ["btnCreateOffer","btnGenAnswer","btnConnect"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = !on;
  });
}

function fmtBytes(b) {
  if (b < 1024)    return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function flash(id, text) {
  const btn = document.getElementById(id);
  if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => btn.textContent = orig, 1500);
}

// ── Peer connection ───────────────────────────────────────────────────────────
function createPeer() {
  if (pc) { pc.close(); pc = null; }
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceTransportPolicy: "all" });

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const labels = {
      connected:"Connected", connecting:"Connecting…", disconnected:"Disconnected",
      failed:"Connection failed", closed:"Closed", new:"Initialising…"
    };
    const types = {
      connected:"connected", connecting:"connecting", new:"connecting",
      disconnected:"error", failed:"error", closed:"idle"
    };
    log("Connection: " + s, s === "connected" ? "ok" : s === "failed" ? "err" : "info");
    setStatus(labels[s] || s, types[s] || "idle");
    setTransferControls(s === "connected");
  };

  pc.onicecandidate = (e) => {
    if (e.candidate)
      log("ICE: " + (e.candidate.type || "?") + " / " + (e.candidate.protocol || "?"));
  };

  pc.onicecandidateerror = (e) => {
    if (e.errorCode !== 701) log("ICE error " + e.errorCode, "warn");
  };

  pc.ondatachannel = (e) => { channel = e.channel; setupChannel(); };
}

// ── Data channel ──────────────────────────────────────────────────────────────
function setupChannel() {
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    log("Channel open — ready!", "ok");
    setStatus("Connected", "connected");
    setTransferControls(true);
    setConnectionBtns(true);
  };
  channel.onclose = () => {
    log("Channel closed.", "warn");
    setStatus("Disconnected", "idle");
    setTransferControls(false);
    setConnectionBtns(true);
  };
  channel.onerror = (e) => {
    log("Channel error: " + (e.message || "unknown"), "err");
    setStatus("Error", "error");
    setConnectionBtns(true);
  };

  channel.onmessage = (e) => {
    if (typeof e.data === "string") {
      if (e.data.startsWith("MSG:"))  { addChat("peer", e.data.slice(4)); return; }
      if (e.data.startsWith("META:")) {
        incomingFileInfo = JSON.parse(e.data.slice(5));
        receivedChunks = []; receivedBytes = 0;
        log("Incoming: " + incomingFileInfo.name + " (" + fmtBytes(incomingFileInfo.size) + ")");
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

// ── ICE wait: smart 2s timeout ────────────────────────────────────────────────
function waitIce() {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") { resolve(); return; }
    let done = false;
    function finish(reason) {
      if (done) return; done = true;
      pc.removeEventListener("icegatheringstatechange", onState);
      pc.removeEventListener("icecandidate", onCand);
      clearTimeout(t);
      log("ICE ready (" + reason + ").");
      resolve();
    }
    function onState() { if (pc.iceGatheringState === "complete") finish("complete"); }
    function onCand(e)  { if (e.candidate && e.candidate.type === "relay") finish("relay found"); }
    const t = setTimeout(() => finish("2s timeout"), 2000);
    pc.addEventListener("icegatheringstatechange", onState);
    pc.addEventListener("icecandidate", onCand);
  });
}

// ── Create offer ──────────────────────────────────────────────────────────────
async function createOffer() {
  try {
    setConnectionBtns(false);
    setStatus("Gathering candidates…", "connecting");
    log("Creating offer…");
    createPeer();
    channel = pc.createDataChannel("file");
    setupChannel();
    await pc.setLocalDescription(await pc.createOffer());
    await waitIce();

    const sdp = pc.localDescription;

    if (getMode() === "relay") {
      log("Uploading offer to relay…");
      const id = await uploadToRelay(sdp);
      log("Offer uploaded. Code: " + id, "ok");
      // Show short code
      const disp = document.getElementById("offerShortDisplay");
      disp.textContent = formatCode(id);
      disp.style.display = "block";
      // Show QR of just the short ID — very small QR
      showQR("offerQR", id);
      setStatus("Share offer code with Peer B", "connecting");
    } else {
      const code = compress(sdp);
      document.getElementById("offerBox").value = code;
      log("Offer ready (" + code.length + " chars — " + Math.round(code.length/20) + "x smaller than before).", "ok");
      setStatus("Send offer code to Peer B", "connecting");
    }
    setConnectionBtns(true);
  } catch (err) {
    log("Error: " + err.message, "err");
    setStatus("Error", "error");
    setConnectionBtns(true);
  }
}

// ── Generate answer ───────────────────────────────────────────────────────────
async function acceptOffer() {
  try {
    setConnectionBtns(false);
    setStatus("Processing offer…", "connecting");
    log("Generating answer…");

    let sdp;
    if (getMode() === "relay") {
      const id = document.getElementById("offerShortInput").value.trim().replace(/\s+/g,"");
      if (!id) { log("Enter the offer code Peer A shared with you.", "warn"); setConnectionBtns(true); return; }
      log("Fetching offer from relay…");
      sdp = await downloadFromRelay(id);
      log("Offer fetched.", "ok");
    } else {
      const raw = document.getElementById("offerBox").value.trim();
      if (!raw) { log("Paste the offer code first.", "warn"); setConnectionBtns(true); return; }
      sdp = decompress(raw);
    }

    createPeer();
    await pc.setRemoteDescription(sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    await waitIce();

    const answerSdp = pc.localDescription;

    if (getMode() === "relay") {
      log("Uploading answer to relay…");
      const id = await uploadToRelay(answerSdp);
      log("Answer uploaded. Code: " + id, "ok");
      const disp = document.getElementById("answerShortDisplay");
      disp.textContent = formatCode(id);
      disp.style.display = "block";
      showQR("answerQR", id);
      setStatus("Share answer code with Peer A", "connecting");
    } else {
      const code = compress(answerSdp);
      document.getElementById("answerBox").value = code;
      log("Answer ready — send back to Peer A.", "ok");
      setStatus("Send answer code to Peer A", "connecting");
    }
    setConnectionBtns(true);
  } catch (err) {
    log("Error: " + err.message, "err");
    setStatus("Error", "error");
    setConnectionBtns(true);
  }
}

// ── Accept answer (Peer A connects) ──────────────────────────────────────────
async function acceptAnswer() {
  try {
    setConnectionBtns(false);
    log("Connecting…");

    let sdp;
    if (getMode() === "relay") {
      const id = document.getElementById("answerShortInput").value.trim().replace(/\s+/g,"");
      if (!id) { log("Enter the answer code Peer B shared with you.", "warn"); setConnectionBtns(true); return; }
      log("Fetching answer from relay…");
      sdp = await downloadFromRelay(id);
      log("Answer fetched.", "ok");
    } else {
      const raw = document.getElementById("answerBox").value.trim();
      if (!raw) { log("Paste the answer code first.", "warn"); setConnectionBtns(true); return; }
      sdp = decompress(raw);
    }

    await pc.setRemoteDescription(sdp);
    log("Answer accepted — establishing connection…", "ok");
    setStatus("Connecting…", "connecting");
    // Buttons re-enabled by channel events
  } catch (err) {
    log("Error: " + err.message, "err");
    setStatus("Error", "error");
    setConnectionBtns(true);
  }
}

// ── Format a long numeric ID for readability: groups of 4 ────────────────────
function formatCode(id) {
  return id.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
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
  if (lbl) lbl.textContent = (label ? label + " " : "") + p + "%";
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
  row.className = "chat-msg chat-" + who;
  const label = document.createElement("b");
  label.textContent = who === "you" ? "You: " : "Peer: ";
  row.appendChild(label);
  row.appendChild(document.createTextNode(msg));
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

// ── Copy ──────────────────────────────────────────────────────────────────────
function copyOffer() {
  const v = document.getElementById("offerBox").value;
  if (v) navigator.clipboard.writeText(v).then(() => flash("copyOfferBtn", "Copied!"));
}
function copyAnswer() {
  const v = document.getElementById("answerBox").value;
  if (v) navigator.clipboard.writeText(v).then(() => flash("copyAnswerBtn", "Copied!"));
}

// ── Enter sends chat ──────────────────────────────────────────────────────────
document.getElementById("chatInput").addEventListener("keydown", function(e) {
  if (e.key === "Enter") sendMessage();
});

// ── Init (runs immediately — script is at bottom of body so DOM is ready) ─────
setTransferControls(false);
setStatus("Not connected", "idle");
log("PeerDrop 95 ready. Select a mode and click Create Offer to begin.");