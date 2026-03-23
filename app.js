"use strict";

let pc;
let channel;
let isOfferer   = false;  // tracks which peer created the original offer
let iceRestarting = false; // prevents multiple simultaneous restart attempts
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

// ── Compression ───────────────────────────────────────────────────────────────
function compress(data) {
  return LZString.compressToEncodedURIComponent(JSON.stringify(data));
}
function decompress(str) {
  const raw = LZString.decompressFromEncodedURIComponent(str);
  if (!raw) throw new Error("Decompression failed — is the code correct?");
  return JSON.parse(raw);
}

// ── Relay (jsonblob.com) ──────────────────────────────────────────────────────
const RELAY_BASE = "https://jsonblob.com/api/jsonBlob";

async function uploadToRelay(sdpObject) {
  const res = await fetch(RELAY_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ d: compress(sdpObject) })
  });
  if (!res.ok) throw new Error("Relay upload failed: " + res.status);
  const loc = res.headers.get("Location") || "";
  const id  = loc.split("/").pop();
  if (!id) throw new Error("Relay returned no ID");
  return id;
}

async function downloadFromRelay(id) {
  const res = await fetch(RELAY_BASE + "/" + id.trim().replace(/\s+/g,""), {
    headers: { "Accept": "application/json" }
  });
  if (!res.ok) throw new Error("Relay fetch failed: " + res.status);
  const obj = await res.json();
  return decompress(obj.d);
}

// ── QR ────────────────────────────────────────────────────────────────────────
function showQR(containerId, text) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = "";
  if (!text) return;
  try {
    new QRCode(el, { text, width: 160, height: 160, correctLevel: QRCode.CorrectLevel.M });
  } catch (e) {
    el.textContent = "QR too large — use copy/paste mode.";
  }
}

// ── Mode ──────────────────────────────────────────────────────────────────────
function getMode() {
  const el = document.querySelector('input[name="mode"]:checked');
  return el ? el.value : "text";
}

function onModeChange() {
  const relay = getMode() === "relay";
  document.getElementById("offerTextArea").style.display   = relay ? "none"  : "block";
  document.getElementById("offerRelayArea").style.display  = relay ? "block" : "none";
  document.getElementById("answerTextArea").style.display  = relay ? "none"  : "block";
  document.getElementById("answerRelayArea").style.display = relay ? "block" : "none";
  document.getElementById("modeHint").textContent = relay
    ? "Uses jsonblob.com — gives a short code + QR. Codes expire after ~30 days."
    : "Copy/paste the code — works offline on same network, no relay needed.";
  ["offerQR","answerQR"].forEach(id => { const e = document.getElementById(id); if (e) e.innerHTML = ""; });
  ["offerShortDisplay","answerShortDisplay"].forEach(id => {
    const e = document.getElementById(id);
    if (e) { e.textContent = ""; e.style.display = "none"; }
  });
}

// ── Logging / status ──────────────────────────────────────────────────────────
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
  ["statusDot"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = "dot dot-" + (type || "idle");
  });
  ["statusText","sbStatus"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });
}

function setTransferControls(on) {
  ["chatInput","sendMsgBtn","sendFileBtn","fileInput"].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = !on;
  });
}

function setConnectionBtns(on) {
  ["btnCreateOffer","btnGenAnswer","btnConnect"].forEach(id => {
    const el = document.getElementById(id); if (el) el.disabled = !on;
  });
}

function fmtBytes(b) {
  if (b < 1024)    return b + " B";
  if (b < 1048576) return (b / 1024).toFixed(1) + " KB";
  return (b / 1048576).toFixed(1) + " MB";
}

function flash(id, text) {
  const btn = document.getElementById(id); if (!btn) return;
  const orig = btn.textContent;
  btn.textContent = text;
  setTimeout(() => btn.textContent = orig, 1500);
}

function formatCode(id) {
  return id.replace(/(\d{4})(?=\d)/g, "$1 ").trim();
}

// ── Reconnect UI ──────────────────────────────────────────────────────────────
function showReconnectPanel(show) {
  const panel = document.getElementById("reconnectPanel");
  if (panel) panel.style.display = show ? "block" : "none";
}

// Called when auto-restart fails and needs manual re-exchange.
// Peer A generates a new local-only offer (fast — no TURN needed on LAN)
// and shows it as a short code for Peer B to paste.
async function manualReconnect() {
  const btn = document.getElementById("btnManualReconnect");
  if (btn) btn.disabled = true;
  showReconnectPanel(false);
  log("Generating reconnect offer (local network only)…", "warn");
  setStatus("Reconnecting…", "connecting");

  try {
    // Create fresh peer — keeps all ICE servers so it works on any network
    createPeer();
    channel = pc.createDataChannel("file");
    setupChannel();
    isOfferer = true;

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce();

    const code = compress(pc.localDescription);

    // Put the reconnect code in the offer box and switch UI to text mode
    document.querySelector('input[name="mode"][value="text"]').checked = true;
    onModeChange();
    document.getElementById("offerBox").value = code;

    log("Reconnect offer ready — share it with Peer B again.", "ok");
    setStatus("Share reconnect offer with Peer B", "connecting");
    if (btn) btn.disabled = false;
  } catch (err) {
    log("Reconnect error: " + err.message, "err");
    setStatus("Reconnect failed", "error");
    if (btn) btn.disabled = false;
    showReconnectPanel(true);
  }
}

// ── ICE restart (automatic, through data channel) ─────────────────────────────
//
// HOW IT WORKS:
// When the connection drops, if the data channel is still alive
// (state = "disconnected" but not yet "failed"), Peer A sends a new
// ICE offer THROUGH the channel itself using the ICE_OFFER: prefix.
// Peer B receives it, creates an answer, sends ICE_ANSWER: back.
// Both peers apply the new descriptions → WebRTC finds the local
// LAN path and reconnects without any internet or user action.
//
// If the channel is dead ("failed"), we fall back to the manual reconnect UI.

let reconnectTimer = null;

function scheduleReconnect() {
  if (iceRestarting) return;
  iceRestarting = true;

  // Wait 3s — WebRTC sometimes heals itself (e.g. brief network blip)
  log("Connection lost — waiting 3s before attempting restart…", "warn");
  reconnectTimer = setTimeout(async () => {
    if (!pc || pc.connectionState === "connected") {
      iceRestarting = false;
      return;
    }
    await attemptIceRestart();
  }, 3000);
}

async function attemptIceRestart() {
  log("Attempting ICE restart…", "warn");
  setStatus("Reconnecting…", "connecting");

  // Only the original offerer (Peer A) drives the ICE restart
  if (!isOfferer) {
    log("Waiting for Peer A to restart ICE…");
    // Answerer just waits — Peer A will send ICE_OFFER through channel if possible
    // If channel is dead, both sides will time out and show the reconnect panel
    setTimeout(() => {
      if (!pc || pc.connectionState !== "connected") {
        log("No restart received from Peer A. Use Reconnect button.", "warn");
        showReconnectPanel(true);
        iceRestarting = false;
      }
    }, 10000);
    return;
  }

  try {
    // Try sending restart offer through the data channel
    if (channel && channel.readyState === "open") {
      log("Sending ICE restart offer via data channel…");
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      await waitIce();
      channel.send("ICE_OFFER:" + compress(pc.localDescription));
      log("ICE restart offer sent — waiting for Peer B's answer…");

      // If no answer within 8s, the channel probably died — show manual UI
      setTimeout(() => {
        if (pc && pc.connectionState !== "connected") {
          log("No answer from Peer B. Use Reconnect button.", "warn");
          showReconnectPanel(true);
          iceRestarting = false;
        }
      }, 8000);

    } else {
      // Channel is dead — can't auto-restart, need manual re-exchange
      log("Channel closed. Use Reconnect button to reconnect over local network.", "warn");
      showReconnectPanel(true);
      iceRestarting = false;
    }
  } catch (err) {
    log("ICE restart error: " + err.message, "err");
    showReconnectPanel(true);
    iceRestarting = false;
  }
}

// ── Peer connection ───────────────────────────────────────────────────────────
function createPeer() {
  if (pc) { pc.close(); pc = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  iceRestarting = false;
  showReconnectPanel(false);

  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, iceTransportPolicy: "all" });

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const labels = {
      connected:"Connected", connecting:"Connecting…", disconnected:"Reconnecting…",
      failed:"Connection lost", closed:"Closed", new:"Initialising…"
    };
    const types = {
      connected:"connected", connecting:"connecting", new:"connecting",
      disconnected:"connecting", failed:"error", closed:"idle"
    };

    log("Connection: " + s, s === "connected" ? "ok" : s === "failed" ? "err" : "info");
    setStatus(labels[s] || s, types[s] || "idle");

    if (s === "connected") {
      // Successfully (re)connected
      setTransferControls(true);
      setConnectionBtns(true);
      showReconnectPanel(false);
      iceRestarting = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    } else if (s === "disconnected" || s === "failed") {
      // Lost connection — disable transfer controls and try to reconnect
      setTransferControls(false);
      if (s === "disconnected") {
        scheduleReconnect();
      } else {
        // "failed" is more severe — try immediately
        if (!iceRestarting) attemptIceRestart();
      }
    }
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
    showReconnectPanel(false);
    iceRestarting = false;
  };

  channel.onclose = () => {
    log("Channel closed.", "warn");
  };

  channel.onerror = (e) => {
    log("Channel error: " + (e.message || "unknown"), "err");
  };

  channel.onmessage = async (e) => {
    if (typeof e.data !== "string") {
      // Binary file chunk
      if (e.data instanceof ArrayBuffer) {
        receivedChunks.push(e.data);
        receivedBytes += e.data.byteLength;
        if (incomingFileInfo)
          updateProgress(Math.min(100, (receivedBytes / incomingFileInfo.size) * 100), "Receiving…");
      }
      return;
    }

    // ── ICE restart: Peer B receives new offer from Peer A ────────────────
    if (e.data.startsWith("ICE_OFFER:")) {
      try {
        log("ICE restart offer received — generating answer…", "warn");
        const offerSdp = decompress(e.data.slice(10));
        await pc.setRemoteDescription(offerSdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await waitIce();
        channel.send("ICE_ANSWER:" + compress(pc.localDescription));
        log("ICE restart answer sent.", "ok");
      } catch (err) {
        log("ICE restart (answerer) error: " + err.message, "err");
      }
      return;
    }

    // ── ICE restart: Peer A receives answer from Peer B ───────────────────
    if (e.data.startsWith("ICE_ANSWER:")) {
      try {
        log("ICE restart answer received — applying…", "warn");
        const answerSdp = decompress(e.data.slice(11));
        await pc.setRemoteDescription(answerSdp);
        log("ICE restart complete — reconnecting…", "ok");
        iceRestarting = false;
      } catch (err) {
        log("ICE restart (offerer) error: " + err.message, "err");
        showReconnectPanel(true);
        iceRestarting = false;
      }
      return;
    }

    // ── Normal messages ───────────────────────────────────────────────────
    if (e.data.startsWith("MSG:"))  { addChat("peer", e.data.slice(4)); return; }

    if (e.data.startsWith("META:")) {
      incomingFileInfo = JSON.parse(e.data.slice(5));
      receivedChunks = []; receivedBytes = 0;
      log("Incoming: " + incomingFileInfo.name + " (" + fmtBytes(incomingFileInfo.size) + ")");
      updateProgress(0, "Receiving…");
      return;
    }

    if (e.data === "EOF") { finalizeDownload(); return; }
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
    function onCand(e) { if (e.candidate && e.candidate.type === "relay") finish("relay found"); }
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
    isOfferer = true;          // this peer drives ICE restarts
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
      const disp = document.getElementById("offerShortDisplay");
      disp.textContent = formatCode(id); disp.style.display = "block";
      showQR("offerQR", id);
      setStatus("Share offer code with Peer B", "connecting");
    } else {
      const code = compress(sdp);
      document.getElementById("offerBox").value = code;
      log("Offer ready (" + code.length + " chars).", "ok");
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
    isOfferer = false;         // this peer waits for ICE restart offers

    let sdp;
    if (getMode() === "relay") {
      const id = document.getElementById("offerShortInput").value.trim().replace(/\s+/g,"");
      if (!id) { log("Enter the offer code.", "warn"); setConnectionBtns(true); return; }
      log("Fetching offer from relay…");
      sdp = await downloadFromRelay(id);
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
      disp.textContent = formatCode(id); disp.style.display = "block";
      showQR("answerQR", id);
      setStatus("Share answer code with Peer A", "connecting");
    } else {
      const code = compress(answerSdp);
      document.getElementById("answerBox").value = code;
      log("Answer ready — send to Peer A.", "ok");
      setStatus("Send answer code to Peer A", "connecting");
    }
    setConnectionBtns(true);
  } catch (err) {
    log("Error: " + err.message, "err");
    setStatus("Error", "error");
    setConnectionBtns(true);
  }
}

// ── Accept answer ─────────────────────────────────────────────────────────────
async function acceptAnswer() {
  try {
    setConnectionBtns(false);
    log("Connecting…");

    let sdp;
    if (getMode() === "relay") {
      const id = document.getElementById("answerShortInput").value.trim().replace(/\s+/g,"");
      if (!id) { log("Enter the answer code.", "warn"); setConnectionBtns(true); return; }
      log("Fetching answer from relay…");
      sdp = await downloadFromRelay(id);
    } else {
      const raw = document.getElementById("answerBox").value.trim();
      if (!raw) { log("Paste the answer code first.", "warn"); setConnectionBtns(true); return; }
      sdp = decompress(raw);
    }

    await pc.setRemoteDescription(sdp);
    log("Answer accepted — connecting…", "ok");
    setStatus("Connecting…", "connecting");
  } catch (err) {
    log("Error: " + err.message, "err");
    setStatus("Error", "error");
    setConnectionBtns(true);
  }
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
  const p = Math.min(100, Math.round(pct));
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

// ── Init ──────────────────────────────────────────────────────────────────────
setTransferControls(false);
setStatus("Not connected", "idle");
log("PeerDrop 95 ready. Select a mode and click Create Offer to begin.");